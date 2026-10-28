import { useEffect, useRef, useState } from "react";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import type { CloudflareAccountConfiguratorRpc } from "../../../../gatekeeper-cloudflare/src/configurator/cloudflare-configurator-types";
import { AccountsSubscriberAdapter, type AccountEvent } from "../../accountsSubscriber";
import { openConnectWindow } from "../../connectHandoff";

export const NOTIFICATIONS_PATTERN = "https://dash.cloudflare.com/:accountId/notifications";
export const WORKER_PATTERN =
  "https://dash.cloudflare.com/:accountId/workers/services/view/:workerName/production/observability";

export type WorkerIssueConnection = AccountEvent & { accountName?: string };

const covers = (account: AccountEvent, patterns: string[]) =>
  account.credentialsValid &&
  patterns.every(
    (pattern) => account.description.grantedResourceUrlPatterns?.includes(pattern) ?? true,
  );

/** Subscribe to grants and inspect account coverage before choosing an identity automatically. */
export const useWorkersIssueConnections = (
  api: RpcStub<AuthenticatedApi>,
  cloudflareAccountId: string,
  patterns: string[],
) => {
  const [accounts, setAccounts] = useState<AccountEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [checked, setChecked] = useState<{ connections: WorkerIssueConnection[]; error?: string }>({
    connections: [],
  });
  const [checking, setChecking] = useState(true);
  const [retry, setRetry] = useState(0);
  const listeners = useRef(new Set<(account: AccountEvent) => void>());

  useEffect(() => {
    let cancelled = false;
    const subscriber = new AccountsSubscriberAdapter({
      add: (account) => {
        if (cancelled || account.vendorId !== "cloudflare") return;
        setAccounts((current) => [...current.filter((value) => value.id !== account.id), account]);
        for (const listener of listeners.current) listener(account);
      },
      remove: (id) => {
        if (!cancelled) setAccounts((current) => current.filter((value) => value.id !== id));
      },
      ready: () => {
        if (!cancelled) setLoaded(true);
      },
    });
    const subscription = api.subscribeConnectedAccounts(subscriber);
    subscription.catch(() => {
      if (!cancelled) {
        setChecking(false);
        setChecked({ connections: [], error: "Could not load Cloudflare connections. Try again." });
      }
    });
    return () => {
      cancelled = true;
      subscription.then((handle) => handle[Symbol.dispose]()).catch(() => {});
    };
  }, [api, retry]);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    setChecking(true);
    Promise.all(
      accounts.map(async (account) => {
        if (!account.credentialsValid) return account;
        const frame = await api.startResourceConfigurator(account.id, NOTIFICATIONS_PATTERN);
        using ui = frame.ui as RpcStub<CloudflareAccountConfiguratorRpc>;
        const matches = await ui.listAccounts(cloudflareAccountId);
        const match = matches.find((value) => value.value === cloudflareAccountId);
        return match ? { ...account, accountName: match.title } : undefined;
      }),
    )
      .then((values) => {
        if (!cancelled)
          setChecked({
            connections: values.filter((value): value is WorkerIssueConnection => Boolean(value)),
          });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setChecked({
            connections: [],
            error:
              error instanceof Error &&
              error.message === "The Cloudflare Gatekeeper is not configured."
                ? "Cloudflare authorization is not configured on this OS installation. Ask the installation administrator to configure the Cloudflare connector, then try again."
                : "Could not verify access to this Cloudflare account. Try again.",
          });
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accounts, api, cloudflareAccountId, loaded, retry]);

  const granted = checked.connections.filter(
    (account) => account.accountName && covers(account, patterns),
  );
  const choices = granted.length ? granted : checked.connections;

  const authorize = async (
    account: WorkerIssueConnection | undefined,
    signal: AbortSignal,
  ): Promise<AccountEvent> => {
    const flow = account
      ? account.credentialsValid
        ? await api.ensureAccountResources(account.id, patterns)
        : await api.reconnectAccount(account.id)
      : await api.connectAccount("cloudflare", patterns);
    signal.throwIfAborted();
    if (!flow && account) return account;
    if (!flow) throw new Error("Cloudflare authorization could not start.");
    // Register before opening: redemption can notify subscribers before openConnectWindow resolves.
    let stop!: () => void;
    const updated = new Promise<AccountEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Authorization timed out. Try again."));
      }, 30 * 60_000);
      const abort = () => {
        stop();
        reject(new Error("Authorization cancelled."));
      };
      const listener = (next: AccountEvent) => {
        if ((!account || next.id === account.id) && next.credentialsValid) {
          stop();
          resolve(next);
        }
      };
      stop = () => {
        clearTimeout(timer);
        listeners.current.delete(listener);
        signal.removeEventListener("abort", abort);
      };
      listeners.current.add(listener);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.all([openConnectWindow(flow, api, signal), updated.then((value) => value)]);
      const connected = await updated;
      return await authorize(connected, signal);
    } finally {
      stop();
    }
  };

  return {
    choices,
    checking,
    error: checked.error,
    authorize,
    retry: () => {
      setLoaded(false);
      setRetry((value) => value + 1);
    },
  };
};
