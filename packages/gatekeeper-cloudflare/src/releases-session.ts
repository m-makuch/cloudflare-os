// The agent-facing session for one Worker releases binding.
//
// Every read authorizes its observation before returning, reporting what its answer depends on:
// the Worker's deployments and versions as `account/<a>/workers-script/<worker>`, each Workers
// Builds build whose commit or branch it returned as `account/<a>/workers-build/<uuid>`, and
// telemetry and Real-Time Issues as the account, `account/<a>`. Audit text names the Worker and
// what kind of thing was read, never a telemetry value, an issue's title, or a caller-chosen ID.
// `resolveIssue` returns nothing, so it submits an action and observes nothing.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { escapeObservationValue } from "@gadgets/gatekeeper-kit/observers";
import type { CloudflareObservabilityApi } from "./observability-api.js";
import {
  assertIssueId, assertVersionId, type CloudflareWorkerReleasesApi, type ReleasesDeployment,
} from "./releases-api.js";
import type { ResolveIssue } from "./releases-actions.js";
import {
  observabilitySubresourceId, workerBuildSubresourceId, workerScriptSubresourceId,
} from "./resources.js";
import type {
  CloudflareWorkerDeployment, CloudflareWorkerDeploymentVersion, CloudflareWorkerIssue,
  CloudflareWorkerReleases,
} from "./types.js";

/** What a releases session reads and stages through, supplied by its gatekeeper. */
export type ReleasesSessionHost = {
  readonly accountId: string;
  readonly workerName: string;
  readonly releases: CloudflareWorkerReleasesApi;
  /** A Worker-scoped telemetry API. */
  readonly telemetry: CloudflareObservabilityApi;
  /** When each issue with a pending resolve was staged, by issue ID. */
  pendingResolves(): Map<string, number>;
  /** Stages a resolve for approval through this session's queue. */
  submitResolve(queue: RpcStub<ApprovalQueue>, payload: ResolveIssue): Promise<void>;
};

/** An issue as reads report it, with any pending resolve applied. */
export function simulateIssue(issue: CloudflareWorkerIssue, stagedAt: number | undefined): CloudflareWorkerIssue {
  return stagedAt === undefined || issue.status === "resolved"
    ? issue
    : { ...issue, status: "resolved", statusUpdated: stagedAt };
}

function publicVersion(version: ReleasesDeployment["versions"][number]): CloudflareWorkerDeploymentVersion {
  return {
    versionId: version.versionId,
    percentage: version.percentage,
    ...(version.tag === undefined ? {} : { tag: version.tag }),
    ...(version.message === undefined ? {} : { message: version.message }),
    ...(version.commit === undefined ? {} : { commit: version.commit }),
    ...(version.branch === undefined ? {} : { branch: version.branch }),
  };
}

function publicDeployment(deployment: ReleasesDeployment): CloudflareWorkerDeployment {
  return {
    id: deployment.id,
    createdOn: deployment.createdOn,
    ...(deployment.source === undefined ? {} : { source: deployment.source }),
    ...(deployment.message === undefined ? {} : { message: deployment.message }),
    versions: deployment.versions.map(publicVersion),
  };
}

@validateRpc()
export class CloudflareWorkerReleasesSessionImpl extends RpcTarget implements CloudflareWorkerReleases {
  readonly #host: ReleasesSessionHost;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #worker: string;

  constructor(host: ReleasesSessionHost, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#queue = queue;
    this.#worker = escapeObservationValue(host.workerName);
  }

  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }

  // Every read authorizes through here, which makes `subresources` required.
  #authorizeObservation(description: ObservationDescription & { subresources: string[] }): Promise<void> {
    return this.#queue.authorizeObservation(description);
  }

  async listDeployments(options?: { limit?: number }): Promise<CloudflareWorkerDeployment[]> {
    const deployments = await this.#host.releases.listDeployments(options?.limit);
    const builds = [...new Set(deployments.flatMap(({ versions }) =>
      versions.flatMap(({ buildUuid }) => buildUuid === undefined ? [] : [buildUuid])))];
    await this.#authorizeObservation({
      title: "Read Worker deployments",
      description: `Worker ${this.#worker}; returned ${deployments.length} deployments` +
        (builds.length > 0 ? ` with the commits of ${builds.length} Workers Builds builds.` : "."),
      subresources: [
        workerScriptSubresourceId(this.#host.accountId, this.#host.workerName),
        ...builds.map(uuid => workerBuildSubresourceId(this.#host.accountId, uuid)),
      ],
    });
    return deployments.map(publicDeployment);
  }

  async countInvocations(versionId: string, since: number): Promise<number> {
    const { count, from, statistics } = await this.#host.telemetry.countInvocations(
      assertVersionId(versionId), since);
    await this.#authorizeObservation({
      title: "Count a Worker version's invocations",
      description: `Worker ${this.#worker}; counted one version's invocations since ` +
        `${new Date(from).toISOString()}; ` +
        `${statistics.rowsRead} rows and ${statistics.bytesRead} bytes scanned.`,
      subresources: [observabilitySubresourceId(this.#host.accountId)],
    });
    return count;
  }

  async getIssue(issueId: string): Promise<CloudflareWorkerIssue> {
    const issue = await this.#host.releases.getIssue(assertIssueId(issueId));
    const simulated = simulateIssue(issue, this.#host.pendingResolves().get(issue.id));
    await this.#authorizeObservation({
      title: "Read a Worker issue",
      description: `Worker ${this.#worker}; read one Real-Time Issue.`,
      subresources: [observabilitySubresourceId(this.#host.accountId)],
    });
    return simulated;
  }

  async resolveIssue(issueId: string): Promise<void> {
    // Read to check the issue is this Worker's and to show the approver what it is; it returns
    // nothing to the caller, so it is not an observation.
    const issue = await this.#host.releases.getIssue(assertIssueId(issueId));
    if (simulateIssue(issue, this.#host.pendingResolves().get(issue.id)).status === "resolved") return;
    await this.#host.submitResolve(this.#queue, {
      issueId: issue.id, title: issue.title, statusAtSubmit: issue.status, stagedAt: Date.now(),
    });
  }
}
