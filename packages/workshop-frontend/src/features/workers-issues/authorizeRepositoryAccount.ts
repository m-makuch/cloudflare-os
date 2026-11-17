import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { AccountsSubscriberAdapter, type AccountEvent } from "../../accountsSubscriber";
import { openConnectWindow } from "../../connectHandoff";

const AUTHORIZATION_TIMEOUT_MS = 30 * 60_000;

/**
 * Returns a connected account of `vendorId` granted `urlPattern`, reusing a connection with valid
 * credentials when there is one, and otherwise opening the vendor's authorization (connect, grant,
 * or reconnect) and waiting for the account to report valid credentials.
 * @returns The account id.
 */
export const authorizeRepositoryAccount = async (
  api: RpcStub<AuthenticatedApi>,
  vendorId: string,
  urlPattern: string,
  signal: AbortSignal,
): Promise<number> => {
  const accounts = new Map<number, AccountEvent>();
  const listeners = new Set<(account: AccountEvent) => void>();
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const subscription = await api.subscribeConnectedAccounts(
    new AccountsSubscriberAdapter({
      add: (account) => {
        if (account.vendorId !== vendorId) return;
        accounts.set(account.id, account);
        for (const listener of listeners) listener(account);
      },
      remove: (id) => accounts.delete(id),
      ready: () => markReady(),
    }),
  );
  try {
    await ready;
    signal.throwIfAborted();
    const existing =
      [...accounts.values()].find((account) => account.credentialsValid) ??
      [...accounts.values()][0];
    const flow = existing
      ? existing.credentialsValid
        ? await api.ensureAccountResources(existing.id, [urlPattern])
        : await api.reconnectAccount(existing.id)
      : await api.connectAccount(vendorId, [urlPattern]);
    signal.throwIfAborted();
    if (!flow && existing) return existing.id;
    if (!flow) throw new Error("Repository authorization could not start.");
    // Register before opening: redemption can notify subscribers before the popup resolves.
    let stop!: () => void;
    const connected = new Promise<AccountEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Authorization timed out. Try again."));
      }, AUTHORIZATION_TIMEOUT_MS);
      const abort = () => {
        stop();
        reject(new Error("Authorization cancelled."));
      };
      const listener = (next: AccountEvent) => {
        if ((!existing || next.id === existing.id) && next.credentialsValid) {
          stop();
          resolve(next);
        }
      };
      stop = () => {
        clearTimeout(timer);
        listeners.delete(listener);
        signal.removeEventListener("abort", abort);
      };
      listeners.add(listener);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.all([openConnectWindow(flow, api, signal), connected]);
      return (await connected).id;
    } finally {
      stop();
    }
  } finally {
    subscription[Symbol.dispose]();
  }
};
