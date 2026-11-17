// Test worker for the workerd suite. Re-exports the production entrypoints so miniflare can bind the
// Durable Objects, and adds a hook Durable Object for the code that depends on `ctx.props`.
//
// `TestHooks` has to be a Durable Object rather than a WorkerEntrypoint: a `DurableObjectClass` from
// `ctx.exports.X({props})` is only reachable through `ctx.facets`, which is the same way the overseer
// instantiates a gatekeeper in production.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ApprovalQueue, ActionDescription, ActionKind, HookController, HookDescription, GatekeeperUserVerifier, GitCache, GitObjectType, GitOid, ObservationDescription }
  from "@gadgets/workshop-shared/gatekeeper";
import type { CloudflareNotificationSubscription, CloudflareWorkerDeployment, CloudflareWorkerIssue } from "../src/types.js";
import { CloudflareNotificationsGatekeeper } from "../src/notifications.js";
import type { CloudflareObservabilityGatekeeper, GatekeeperUserImpl } from "../src/cloudflare.js";
import type { CloudflareWorkerReleasesGatekeeper } from "../src/releases.js";

export { default } from "../src/cloudflare.js";
export * from "../src/cloudflare.js";

type GatekeeperProps = {
  userObjectId: string;
  accountId: string;
  workerName?: string;
};

type ReleasesProps = { userObjectId: string; accountId: string; workerName: string };

export type TestExports = {
  CloudflareObservabilityGatekeeper(options: { props: GatekeeperProps }):
    DurableObjectClass<CloudflareObservabilityGatekeeper>;
  CloudflareWorkerReleasesGatekeeper(options: { props: ReleasesProps }):
    DurableObjectClass<CloudflareWorkerReleasesGatekeeper>;
  GatekeeperUserImpl(options: { props: { userObjectId: string } }): Fetcher<GatekeeperUserImpl>;
  TestConnectCallback(options: { props: { label: string } }): Fetcher<TestConnectCallback>;
};

/**
 * Stands in for the git cache the overseer passes to `applyAction()`. This read-only gatekeeper
 * never touches it, so every method just throws.
 */
class TestGitCache extends RpcTarget implements GitCache {
  async get(_id: GitOid): Promise<{type: GitObjectType, content: Uint8Array} | null> {
    throw new Error("not implemented");
  }
  async has(_id: GitOid): Promise<boolean> { throw new Error("not implemented"); }
  async stat(_id: GitOid): Promise<{type: GitObjectType, size: number} | null> {
    throw new Error("not implemented");
  }
  async put(_type: GitObjectType, _content: Uint8Array): Promise<GitOid> {
    throw new Error("not implemented");
  }
  async advertiseCommit(_commitId: GitOid): Promise<void> { throw new Error("not implemented"); }
  async buildPack(): Promise<ReadableStream<Uint8Array>> { throw new Error("not implemented"); }
  async consumePack(_pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
    throw new Error("not implemented");
  }
  async isAncestor(_ancestor: GitOid, _descendant: GitOid): Promise<boolean> {
    throw new Error("not implemented");
  }
}

/** Stands in for another user's Cloudflare account during an observer access check. */
class TestVerifier extends RpcTarget {
  /** The account IDs `checkTelemetryAccess` was asked about, in order. */
  readonly asked: string[] = [];

  constructor(private readonly outcome: boolean | string) {
    super();
  }

  async hasObservabilityAccess(): Promise<boolean> {
    if (typeof this.outcome === "string") throw new Error(this.outcome);
    return this.outcome;
  }

  async checkTelemetryAccess(accountIds: string[]): Promise<boolean[]> {
    this.asked.push(...accountIds);
    if (typeof this.outcome === "string") throw new Error(this.outcome);
    return accountIds.map(() => this.outcome === true);
  }

  async checkSubresourceAccess(subresources: string[]): Promise<boolean[]> {
    this.asked.push(...subresources);
    if (typeof this.outcome === "string") throw new Error(this.outcome);
    return subresources.map(() => this.outcome === true);
  }
}

/** What Worker releases gatekeepers submitted and observed through ReleasesTestQueue. */
const releasesLog: { submitted: { id: number; description: ActionDescription }[]; observations: ObservationDescription[] } =
  { submitted: [], observations: [] };

/** Stands in for the overseer's queue: records submissions and observations, authorizing all. */
class ReleasesTestQueue extends RpcTarget implements ApprovalQueue {
  async requireLive(): Promise<void> {}
  async watchSession(): Promise<never> { throw new Error("Unexpected session watcher"); }
  async getExecutionId(): Promise<undefined> { return undefined; }
  async getGitCache(): Promise<GitCache> { throw new Error("Unexpected git cache"); }
  async submitAction(id: number, description: ActionDescription): Promise<void> {
    releasesLog.submitted.push({ id, description });
  }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    releasesLog.observations.push(description);
  }
  async bindHook(): Promise<void> { throw new Error("Unexpected hook"); }
}

/** What a releases test call returned, or why it threw. */
type ReleasesOutcome = {
  result?: CloudflareWorkerIssue | CloudflareWorkerDeployment[] | number | { message?: string; canRetry?: boolean };
  error?: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The labels of the `TestConnectCallback`s notified of credential expiry, in arrival order. */
export const expiryNotices: string[] = [];

/** Stands in for the Workshop's connect callback, which an account stores to report expiry. */
export class TestConnectCallback extends WorkerEntrypoint<Env, { label: string }> {
  async credentialsExpired(): Promise<void> {
    expiryNotices.push(this.ctx.props.label);
  }
}

class SubscriptionTestQueue extends RpcTarget implements ApprovalQueue {
  async requireLive(): Promise<void> {}
  async watchSession(): Promise<never> { throw new Error("Unexpected session watcher"); }
  async getExecutionId(): Promise<undefined> { return undefined; }
  descriptions: HookDescription[] = [];
  async getGitCache(): Promise<GitCache> { throw new Error("Unexpected git cache"); }
  async submitAction(_action: number, _description: ActionDescription): Promise<void> { throw new Error("Unexpected action"); }
  async authorizeObservation(_description: ObservationDescription): Promise<void> { throw new Error("Unexpected observation"); }
  async bindHook<Hook extends RpcTarget>(_controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>, description: HookDescription): Promise<void> {
    this.descriptions.push(description);
  }
}

export class TestHooks extends DurableObject<Env> {
  async subscribeNotification(props: { userObjectId: string; accountId: string }, subscription: CloudflareNotificationSubscription): Promise<{ descriptions: HookDescription[]; error: string | null }> {
    const gatekeeper = this.ctx.facets.get<CloudflareNotificationsGatekeeper>("notifications", () => ({
      class: this.ctx.exports.CloudflareNotificationsGatekeeper({ props }),
    }));
    const queue = new SubscriptionTestQueue();
    using session = await gatekeeper.startSession(queue);
    using callback = new RpcStub(new NotificationTestCallback("approval-test"));
    try {
      await session.subscribe(callback, subscription);
      return { descriptions: queue.descriptions, error: null };
    } catch (error) {
      return { descriptions: queue.descriptions, error: error instanceof Error ? error.message : String(error) };
    }
  }

  #gatekeeper(facetName: string, props: GatekeeperProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<CloudflareObservabilityGatekeeper>(facetName, () => ({
      class: exports.CloudflareObservabilityGatekeeper({ props }),
    }));
  }

  /**
   * Run `addObserver` against a verifier with a known answer. Returns the thrown message, or null
   * when the collaborator was admitted, so the test can assert on both outcomes.
   */
  async addObserver(
    facetName: string, props: GatekeeperProps, outcome: boolean | string,
  ): Promise<string | null> {
    // A local RpcTarget stands in for the remote verifier the overseer would pass; only
    // `hasObservabilityAccess` is ever called on it.
    const verifier = new RpcStub(new TestVerifier(outcome)) as unknown as
      Fetcher<GatekeeperUserVerifier>;
    try {
      await this.#gatekeeper(facetName, props).addObserver("observer-1", verifier);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Run `verifyObserverAccess` for observers, keyed by ID, whose verifiers have known answers.
   * Returns the allowed observer IDs or the thrown message, and what each verifier was asked.
   */
  async verifyObserverAccess(
    facetName: string, props: GatekeeperProps,
    outcomes: Record<string, boolean | string>, subresources: string[],
  ): Promise<{ result: string[] | string; asked: Record<string, string[]> }> {
    const verifiers = Object.entries(outcomes).map(([id, outcome]) => ({ id, target: new TestVerifier(outcome) }));
    const observers = verifiers.map(({ id, target }) => ({
      id, verifier: new RpcStub(target) as unknown as Fetcher<GatekeeperUserVerifier>,
    }));
    let result: string[] | string;
    try {
      ({ allowedObserverIds: result } =
        await this.#gatekeeper(facetName, props).verifyObserverAccess(observers, subresources));
    } catch (error) {
      result = error instanceof Error ? error.message : String(error);
    }
    return { result, asked: Object.fromEntries(verifiers.map(({ id, target }) => [id, target.asked])) };
  }

  /** The resource description for a binding, which encodes the account/Worker split. */
  async describeResource(
    facetName: string, props: GatekeeperProps,
  ): Promise<{ url: string; title: string; suggestedBindingName: string }> {
    const { url, title, suggestedBindingName } =
      await this.#gatekeeper(facetName, props).describe();
    return { url, title, suggestedBindingName };
  }

  #releases(facetName: string, props: ReleasesProps) {
    const exports = this.ctx.exports as unknown as TestExports;
    return this.ctx.facets.get<CloudflareWorkerReleasesGatekeeper>(facetName, () => ({
      class: exports.CloudflareWorkerReleasesGatekeeper({ props }),
    }));
  }

  /** Clears what releasesLog() reports. */
  resetReleasesLog(): void {
    releasesLog.submitted.length = 0;
    releasesLog.observations.length = 0;
  }

  releasesLog(): typeof releasesLog {
    return structuredClone(releasesLog);
  }

  /** Runs one session call on a releases binding, returning its result or thrown message. */
  async releasesSession(
    facetName: string, props: ReleasesProps,
    call: { method: "getIssue" | "resolveIssue"; issueId: string } |
      { method: "listDeployments"; limit?: number } |
      { method: "countInvocations"; versionId: string; since: number },
  ): Promise<ReleasesOutcome> {
    using session = await this.#releases(facetName, props).startSession(new ReleasesTestQueue());
    try {
      switch (call.method) {
        case "getIssue": return { result: await session.getIssue(call.issueId) };
        case "resolveIssue": await session.resolveIssue(call.issueId); return {};
        case "listDeployments": return { result: await session.listDeployments({ limit: call.limit }) };
        case "countInvocations": return { result: await session.countInvocations(call.versionId, call.since) };
      }
    } catch (error) {
      return { error: message(error) };
    }
  }

  /** Resolves an action on a releases binding the way the overseer does. */
  async releasesDecide(
    facetName: string, props: ReleasesProps, decision: "apply" | "reject" | "revert", actionId: number,
  ): Promise<ReleasesOutcome> {
    const gatekeeper = this.#releases(facetName, props);
    try {
      switch (decision) {
        case "apply": await gatekeeper.applyAction(actionId, new RpcStub(new TestGitCache())); return {};
        case "reject": await gatekeeper.rejectAction(actionId); return {};
        case "revert": {
          const outcome = await gatekeeper.revertAction(actionId);
          return outcome ? { result: outcome } : {};
        }
      }
    } catch (error) {
      return { error: message(error) };
    }
  }

  async releasesAutoApprovable(facetName: string, props: ReleasesProps): Promise<ActionKind[]> {
    return await this.#releases(facetName, props).getAutoApprovableActions();
  }

  async observabilityAutoApprovable(facetName: string, props: GatekeeperProps): Promise<ActionKind[]> {
    return await this.#gatekeeper(facetName, props).getAutoApprovableActions();
  }

  async describeReleases(facetName: string, props: ReleasesProps) {
    const { url, title, suggestedBindingName, tsType } = await this.#releases(facetName, props).describe();
    return { url, title, suggestedBindingName, tsType };
  }

  async releasesHistoricalSubresources(facetName: string, props: ReleasesProps): Promise<string[]> {
    return await this.#releases(facetName, props).getHistoricalSubresources();
  }

  /** As verifyObserverAccess, on a releases binding. */
  async verifyReleasesAccess(
    facetName: string, props: ReleasesProps,
    outcomes: Record<string, boolean | string>, subresources: string[],
  ): Promise<{ result: string[] | string; asked: Record<string, string[]> }> {
    const verifiers = Object.entries(outcomes).map(([id, outcome]) => ({ id, target: new TestVerifier(outcome) }));
    const observers = verifiers.map(({ id, target }) => ({
      id, verifier: new RpcStub(target) as unknown as Fetcher<GatekeeperUserVerifier>,
    }));
    let result: string[] | string;
    try {
      ({ allowedObserverIds: result } =
        await this.#releases(facetName, props).verifyObserverAccess(observers, subresources));
    } catch (error) {
      result = message(error);
    }
    return { result, asked: Object.fromEntries(verifiers.map(({ id, target }) => [id, target.asked])) };
  }

  /** GatekeeperUser.ensureResources for an account, as the Workshop calls it. */
  async ensureResources(userObjectId: string, patterns: string[]): Promise<{ url?: string }> {
    const exports = this.ctx.exports as unknown as TestExports;
    return await exports.GatekeeperUserImpl({ props: { userObjectId } }).ensureResources(patterns);
  }

  /** GatekeeperUser.getGatekeeperClassFor's resource, or its refusal. */
  async resourceFor(userObjectId: string, url: string): Promise<string> {
    const exports = this.ctx.exports as unknown as TestExports;
    try {
      return (await exports.GatekeeperUserImpl({ props: { userObjectId } }).getGatekeeperClassFor(url)).resource.urlPattern;
    } catch (error) {
      return message(error);
    }
  }

  /** Confirms the read-only resource refuses every mutating gatekeeper operation. */
  async applyActionMessage(facetName: string, props: GatekeeperProps): Promise<string> {
    try {
      // The overseer always passes an action-scoped git cache with the apply call, and the
      // validator (sharpened by the `Gatekeeper` interface) requires it, so the test passes a
      // stand-in the same way.
      await this.#gatekeeper(facetName, props).applyAction(1, new RpcStub(new TestGitCache()));
      return "did not throw";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
// Export classes directly so the Workers test runner can discover them for ctx.exports.
export { GatekeeperUserImpl } from "../src/cloudflare.js";
export { CloudflareNotificationReceiver, CloudflareNotificationsGatekeeper,
  CloudflareNotificationHookController } from "../src/notifications.js";

const notificationEvents: string[] = [];
const notificationObservations: ObservationDescription[] = [];
let rejectNotification = false;
let rejectedNotificationHook: string | undefined;
let denyNotificationObservation = false;
let callbackBarrier: Promise<void> | undefined;
let releaseCallback: (() => void) | undefined;
let callbackBlocked: Promise<void> = Promise.resolve();
let markCallbackBlocked: (() => void) | undefined;
class NotificationTestQueue extends RpcTarget {
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    notificationEvents.push("authorize");
    notificationObservations.push(description);
    if (denyNotificationObservation) throw new Error("Observation denied");
  }
}
class NotificationTestCallback extends RpcTarget {
  constructor(private hookId: string) { super(); }
  async onNotification(value: { id: string }): Promise<void> {
    notificationEvents.push(`callback:${JSON.stringify({ ...value, subscriber: this.hookId })}`);
    if (callbackBarrier) {
      markCallbackBlocked?.();
      await callbackBarrier;
    }
    if (rejectNotification && (!rejectedNotificationHook || rejectedNotificationHook === this.hookId)) throw new Error("callback rejected");
  }
}
export class NotificationTestHooks extends WorkerEntrypoint {
  async startHook() { return { callback: new NotificationTestCallback((this.ctx.props as { hookId: string }).hookId), approvalQueue: new NotificationTestQueue() }; }
  async reset(reject: boolean, denyObservation = false, rejectedHook?: string) {
    notificationEvents.length = 0;
    notificationObservations.length = 0;
    rejectNotification = reject;
    rejectedNotificationHook = rejectedHook;
    denyNotificationObservation = denyObservation;
    releaseCallback?.();
    callbackBarrier = undefined;
    releaseCallback = undefined;
    markCallbackBlocked = undefined;
    callbackBlocked = Promise.resolve();
  }
  async read() { return [...notificationEvents]; }
  async readObservations() { return [...notificationObservations]; }
  blockCallback(): void {
    callbackBlocked = new Promise(resolve => { markCallbackBlocked = resolve; });
    callbackBarrier = new Promise(resolve => { releaseCallback = resolve; });
  }
  waitUntilCallbackBlocked(): Promise<void> { return callbackBlocked; }
  releaseCallback(): void {
    releaseCallback?.();
    callbackBarrier = undefined;
  }
}
