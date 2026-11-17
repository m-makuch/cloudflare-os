// The per-binding gatekeeper for one Worker's releases: its deployments, its versions' traffic, and
// its Real-Time Issues, which it may mark resolved. A sibling of CloudflareObservabilityGatekeeper
// rather than a mode of it, so that a Worker observability binding (which an investigating agent
// holds) never gains the write.
//
// Observers: every read reports its subresources (releases-session.ts), and verifyObserverAccess()
// checks each one with the observer's own connection (UserAccount.checkSubresourceAccess). New
// gatekeeper contract: addObserver() and removeObserver() are no-ops.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { observerAccessVerifier } from "@gadgets/gatekeeper-kit/observers";
import { CloudflareObservabilityApi, deniesAccess } from "./observability-api.js";
import { obsContext } from "./observability.js";
import { CloudflareWorkerReleasesApi } from "./releases-api.js";
import { releasesActions, type ReleasesAction, type ReleasesActionHost } from "./releases-actions.js";
import { CloudflareWorkerReleasesSessionImpl, type ReleasesSessionHost } from "./releases-session.js";
import { parseCloudflareSubresourceId, workerReleasesUrl } from "./resources.js";
import type { CloudflareWorkerReleases } from "./types.js";
import { VENDOR_ID } from "./vendor.js";
import TYPES_CODE from "./types.txt";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.releases", vendorId: VENDOR_ID,
});

/** How long an applied resolve stays revertible. */
const RETAINED_ACTION_TTL_MS = 30 * 24 * 60 * 60_000;

type ReleasesProps = { userObjectId: string; accountId: string; workerName: string };

/** The verifier surface this gatekeeper asks, implemented by CloudflareVerifier in cloudflare.ts. */
export interface CloudflareSubresourceVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether this connected Cloudflare account can read each subresource, in order (see
   * UserAccount.checkSubresourceAccess). Throws when access can't be determined.
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}

const verifyReleasesAccess = observerAccessVerifier<CloudflareSubresourceVerifierApi>({
  hasCollectionAccess: (verifier, subresources) => verifier.checkSubresourceAccess([...subresources]),
});

@validateRpc()
export class CloudflareWorkerReleasesGatekeeper extends DurableObject<Cloudflare.Env, ReleasesProps>
    implements Gatekeeper<CloudflareWorkerReleases> {
  readonly #journal = new ActionJournal<ReleasesAction>(this.ctx.storage.kv, { namespace: "releases" });
  readonly #actionHost: ReleasesActionHost = {
    workerName: this.ctx.props.workerName,
    api: () => this.#releasesApi(),
  };
  readonly #actions = releasesActions.bind(this.#journal, this.#actionHost);

  #getToken(): () => Promise<string | null> {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return () => account.getAccessToken();
  }

  #releasesApi(): CloudflareWorkerReleasesApi {
    return new CloudflareWorkerReleasesApi(this.#getToken(), this.ctx.props.accountId, this.ctx.props.workerName);
  }

  async describe(): Promise<ResourceDescription> {
    const { accountId, workerName } = this.ctx.props;
    return {
      url: workerReleasesUrl(accountId, workerName),
      title: `${workerName} releases`,
      snippet: `Read deployments and Real-Time Issues of ${workerName}, and mark its issues resolved.`,
      suggestedBindingName: "WORKER_RELEASES",
      tsType: "CloudflareWorkerReleases",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#actions.autoApprovableKinds();
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<CloudflareWorkerReleases> {
    const { accountId, workerName } = this.ctx.props;
    const getToken = this.#getToken();
    const host: ReleasesSessionHost = {
      accountId,
      workerName,
      releases: new CloudflareWorkerReleasesApi(getToken, accountId, workerName),
      telemetry: new CloudflareObservabilityApi(getToken, accountId, workerName),
      pendingResolves: () => new Map(this.#journal.listPending().flatMap(({ action }) =>
        action.kind === "resolveIssue" ? [[action.payload.issueId, action.payload.stagedAt]] : [])),
      submitResolve: async (queue, payload) => {
        await this.#actions.submit(queue, "resolveIssue", payload);
      },
    };
    return new CloudflareWorkerReleasesSessionImpl(host, approvalQueue.dup());
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#pruneRetained();
    await this.#actions.apply(actionId);
  }

  async rejectAction(actionId: number): Promise<void> {
    await this.#actions.reject(actionId);
  }

  /** Restores the status an applied resolve replaced, unless the issue has moved on since. */
  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean }> {
    return await this.#actions.runExclusive(async () => {
      const record = this.#journal.get(actionId);
      if (record?.state !== "applied" || record.action.kind !== "resolveIssue") {
        return { message: "This action is too old to undo automatically.", canRetry: false };
      }
      const { issueId, previousStatus } = record.action.payload;
      const api = this.#releasesApi();
      if (previousStatus !== undefined && previousStatus !== "resolved") {
        try {
          const current = await api.getIssue(issueId);
          // Recurred (active again) or changed by someone since: nothing of this action is left
          // to undo.
          if (current.status !== "resolved") {
            this.#journal.retire(actionId);
            await this.#actions.resolved("reverted");
            return { message: `The issue is ${current.status} now, so its status was left as it is.` };
          }
          await api.setIssueStatus(issueId, previousStatus);
        } catch (error) {
          // Cloudflare's refusal is final; an outage or expired credentials may pass, so those
          // are thrown for the user to retry.
          if (deniesAccess(error)) {
            return { message: `Cloudflare refused to undo this action: ${error.message}`, canRetry: false };
          }
          throw error;
        }
      }
      this.#journal.retire(actionId);
      await this.#actions.resolved("reverted");
    });
  }

  /**
   * Every ID a read through this binding reports names its own account, Worker, or a build in its
   * account; any other fails the whole call. Each is checked with the observer's own connection.
   */
  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    const { accountId, workerName } = this.ctx.props;
    for (const id of subresources) {
      const parsed = parseCloudflareSubresourceId(id);
      if (parsed.accountId !== accountId ||
          (parsed.kind === "script" && parsed.workerName !== workerName)) {
        throw new Error("This subresource ID names another account or Worker than this binding's.");
      }
    }
    return await verifyReleasesAccess(observers, subresources);
  }

  /**
   * A new resource type, so no read was ever made without reporting its subresources. Exported
   * conservatively anyway: what every binding of this kind may disclose, its account's telemetry and
   * its Worker's deployments, both of which verifyObserverAccess() checks.
   */
  /** A new resource kind: it never observed under the legacy protocol, so it has nothing to export. */
  async getHistoricalSubresources(): Promise<string[]> {
    return [];
  }

  /** Compatibility only: observers are authorized per read, in verifyObserverAccess(). */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Compatibility only: there is no observer state to remove. */
  async removeObserver(_id: string): Promise<void> {}

  /** Retires applied resolves past RETAINED_ACTION_TTL_MS, which can no longer be reverted. */
  async #pruneRetained(): Promise<void> {
    const cutoff = Date.now() - RETAINED_ACTION_TTL_MS;
    try {
      await this.#actions.runExclusive(() => {
        let cursor: string | undefined;
        do {
          const page = this.#journal.listRetained({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
          for (const { id, action } of page.entries) {
            if ((action.payload.appliedAt ?? 0) < cutoff) this.#journal.retire(id);
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      });
    } catch (error) {
      logger.warn("pruning applied Worker issue resolves failed", { event: "releases.prune.failed", error });
    }
  }
}
