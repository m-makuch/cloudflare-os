// The Cloudflare API calls behind a Worker releases binding: the Worker's deployments joined with
// each version's annotations and its Workers Builds commit, and the Worker's Real-Time Issues.
// Every request goes through `requestCloudflareApi` (observability-api.ts), and every response is
// narrowed here before anything downstream reads it, as observability-parse.ts does for telemetry.

import { obsContext } from "./observability.js";
import { VENDOR_ID } from "./vendor.js";
import { assertCloudflareAccountId } from "./resources.js";
import { deniesAccess, requestCloudflareApi, type CloudflareApiRequest } from "./observability-api.js";
import { CloudflareObservabilityApiError, invalidResponse, isFiniteNumber, isRecord } from "./observability-parse.js";
import type { CloudflareWorkerIssue } from "./types.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare.releases-api", vendorId: VENDOR_ID,
});

/** The most deployments one listing returns, which also bounds the versions it looks up. */
export const MAX_DEPLOYMENTS = 20;
const DEFAULT_DEPLOYMENTS = 10;
/** Version IDs one Workers Builds lookup accepts. */
const BUILDS_BATCH = 20;
/** Version lookups in flight at once, to stay clear of the per-user rate limit. */
const VERSION_CONCURRENCY = 4;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUE_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const ISSUE_STATUSES = new Set(["active", "resolved", "ignored"]);

/** A Real-Time Issue's status. */
export type IssueStatus = CloudflareWorkerIssue["status"];

/** One deployment as the releases read returns it, before it is shaped for the caller. */
export type ReleasesDeployment = {
  id: string;
  createdOn: string;
  source?: string;
  message?: string;
  versions: ReleasesDeploymentVersion[];
};

export type ReleasesDeploymentVersion = {
  versionId: string;
  percentage: number;
  tag?: string;
  message?: string;
  commit?: string;
  branch?: string;
  /** The Workers Builds build `commit` and `branch` came from, for the subresource it reports. */
  buildUuid?: string;
};

/** Validates a Worker version ID at the caller boundary, returning its canonical lowercase form. */
export function assertVersionId(versionId: string): string {
  if (!UUID_PATTERN.test(versionId)) throw new Error("Invalid Worker version ID.");
  return versionId.toLowerCase();
}

/** Validates a Real-Time Issue ID at the caller boundary. */
export function assertIssueId(issueId: string): string {
  if (!ISSUE_ID_PATTERN.test(issueId)) throw new Error("Invalid Workers Observability issue ID.");
  return issueId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function annotation(annotations: unknown, key: string): string | undefined {
  return isRecord(annotations) ? optionalString(annotations[key]) : undefined;
}

type ListedDeployment = Omit<ReleasesDeployment, "versions"> & {
  versions: { versionId: string; percentage: number }[];
};

function parseDeployments(value: unknown): ListedDeployment[] {
  if (!isRecord(value) || !Array.isArray(value.deployments)) throw invalidResponse();
  return value.deployments.map(deployment => {
    if (!isRecord(deployment) || typeof deployment.id !== "string" ||
        typeof deployment.created_on !== "string" || !Array.isArray(deployment.versions)) {
      throw invalidResponse();
    }
    return {
      id: deployment.id,
      createdOn: deployment.created_on,
      source: optionalString(deployment.source),
      message: annotation(deployment.annotations, "workers/message"),
      versions: deployment.versions.map(version => {
        if (!isRecord(version) || typeof version.version_id !== "string" ||
            !UUID_PATTERN.test(version.version_id) || !isFiniteNumber(version.percentage)) {
          throw invalidResponse();
        }
        return { versionId: version.version_id.toLowerCase(), percentage: version.percentage };
      }),
    };
  });
}

/** A version's annotations; tolerant, since every one of them is optional. */
function parseVersionAnnotations(value: unknown): { tag?: string; message?: string } {
  if (!isRecord(value)) throw invalidResponse();
  return {
    tag: annotation(value.annotations, "workers/tag"),
    message: annotation(value.annotations, "workers/message"),
  };
}

type BuildCommit = { buildUuid: string; commit?: string; branch?: string };

/**
 * The `{builds: {[versionId]: build}}` map. A version Workers Builds did not build is simply
 * absent; a manual build reports an empty `commit_hash`, which is no commit.
 */
function parseBuilds(value: unknown): Map<string, BuildCommit> {
  const builds = new Map<string, BuildCommit>();
  if (!isRecord(value)) throw invalidResponse();
  if (value.builds === undefined || value.builds === null) return builds;
  if (!isRecord(value.builds) || Array.isArray(value.builds)) throw invalidResponse();
  for (const [versionId, build] of Object.entries(value.builds)) {
    if (!isRecord(build)) throw invalidResponse();
    // A build without a well-formed UUID cannot be reported as a subresource, so its commit is
    // dropped rather than returned unaccounted for.
    if (typeof build.build_uuid !== "string" || !UUID_PATTERN.test(build.build_uuid)) continue;
    const metadata = isRecord(build.build_trigger_metadata) ? build.build_trigger_metadata : {};
    const commit = optionalString(metadata.commit_hash);
    const branch = optionalString(metadata.branch);
    if (commit === undefined && branch === undefined) continue;
    builds.set(versionId.toLowerCase(), { buildUuid: build.build_uuid.toLowerCase(), commit, branch });
  }
  return builds;
}

/** Narrow a Real-Time Issue, keeping the service it belongs to for the caller to check. */
/** An issue read's result, which Cloudflare wraps as `{ issue }`. */
function parseIssue(result: unknown): CloudflareWorkerIssue & { service: string } {
  const value = isRecord(result) ? result.issue : undefined;
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.service !== "string" ||
      typeof value.title !== "string" || typeof value.status !== "string" ||
      !ISSUE_STATUSES.has(value.status) || !isFiniteNumber(value.count) ||
      !isFiniteNumber(value.firstObserved) || !isFiniteNumber(value.lastObserved) ||
      !isFiniteNumber(value.statusUpdated)) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    service: value.service,
    title: value.title,
    status: value.status as IssueStatus,
    count: value.count,
    firstObserved: value.firstObserved,
    lastObserved: value.lastObserved,
    statusUpdated: value.statusUpdated,
    ...(typeof value.fingerprint === "string" && value.fingerprint !== ""
      ? { fingerprint: value.fingerprint } : {}),
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}

/** One Worker's deployments, versions, builds and Real-Time Issues. */
export class CloudflareWorkerReleasesApi {
  readonly #accountId: string;

  constructor(
    private readonly getToken: () => Promise<string | null>,
    accountId: string,
    readonly workerName: string,
  ) {
    this.#accountId = assertCloudflareAccountId(accountId);
  }

  #request(request: CloudflareApiRequest): Promise<unknown> {
    return requestCloudflareApi(this.getToken, this.#accountId, request);
  }

  #script(): string {
    return `/workers/scripts/${encodeURIComponent(this.workerName)}`;
  }

  /** The Worker's deployments as Cloudflare lists them, newest first. */
  async #deployments() {
    return parseDeployments(await this.#request({
      method: "GET", path: `${this.#script()}/deployments`, label: "deployments",
    }));
  }

  /**
   * The newest `limit` deployments (default 10, at most MAX_DEPLOYMENTS), each version joined with
   * its annotations and, when Workers Builds built it from a commit, that commit. Build data is
   * left out, with a warning, when Cloudflare refuses the builds lookup: a token without Workers CI
   * access can still list deployments.
   */
  async listDeployments(limit = DEFAULT_DEPLOYMENTS): Promise<ReleasesDeployment[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEPLOYMENTS) {
      throw new Error(`The deployment limit must be an integer from 1 to ${MAX_DEPLOYMENTS}.`);
    }
    const deployments = (await this.#deployments()).slice(0, limit);
    const versionIds = [...new Set(deployments.flatMap(({ versions }) => versions.map(v => v.versionId)))];
    const [annotations, builds] = await Promise.all([
      mapLimit(versionIds, VERSION_CONCURRENCY, versionId => this.#versionAnnotations(versionId)),
      this.#builds(versionIds),
    ]);
    const annotationsById = new Map(versionIds.map((versionId, index) => [versionId, annotations[index]!]));
    return deployments.map(deployment => ({
      ...deployment,
      versions: deployment.versions.map(({ versionId, percentage }) => {
        const build = builds.get(versionId);
        return {
          versionId,
          percentage,
          ...annotationsById.get(versionId),
          ...(build ? { commit: build.commit, branch: build.branch, buildUuid: build.buildUuid } : {}),
        };
      }),
    }));
  }

  async #versionAnnotations(versionId: string): Promise<{ tag?: string; message?: string }> {
    try {
      return parseVersionAnnotations(await this.#request({
        method: "GET", path: `${this.#script()}/versions/${encodeURIComponent(versionId)}`,
        label: "versions.get",
      }));
    } catch (error) {
      // A version a deployment still names but Cloudflare no longer serves has no annotations to
      // report; anything else fails the listing.
      if (error instanceof CloudflareObservabilityApiError && error.status === 404) return {};
      throw error;
    }
  }

  async #builds(versionIds: string[]): Promise<Map<string, BuildCommit>> {
    const builds = new Map<string, BuildCommit>();
    for (let start = 0; start < versionIds.length; start += BUILDS_BATCH) {
      const batch = versionIds.slice(start, start + BUILDS_BATCH);
      let result: unknown;
      try {
        result = await this.#request({
          method: "GET", path: "/builds/builds", query: { version_ids: batch.join(",") }, label: "builds",
        });
      } catch (error) {
        if (!deniesAccess(error)) throw error;
        // Not connected to Workers Builds, or no Workers CI access: the listing goes on without
        // commits. Codes only, as everywhere a provider error is logged.
        logger.warn("Workers Builds lookup refused; listing deployments without commits", {
          event: "releases.builds.refused", status: error.status,
          ...(error.codes.length > 0 ? { providerCodes: error.codes.join(",") } : {}),
        });
        return new Map();
      }
      for (const [versionId, build] of parseBuilds(result)) {
        if (batch.includes(versionId)) builds.set(versionId, build);
      }
    }
    return builds;
  }

  /**
   * A Real-Time Issue of this Worker. Throws, without returning anything about it, when the issue
   * belongs to another Worker: an issue ID is account-wide.
   */
  async getIssue(issueId: string): Promise<CloudflareWorkerIssue> {
    const issue = parseIssue(await this.#request({
      method: "GET", path: `/workers/observability/issues/${encodeURIComponent(assertIssueId(issueId))}`,
      label: "issues.get",
    }));
    if (issue.service !== this.workerName) {
      throw new CloudflareObservabilityApiError(404, `Issue ${issueId} is not an issue of this Worker.`);
    }
    const { service: _service, ...visible } = issue;
    return visible;
  }

  /**
   * Sets an issue's status, sent once, after checking again that it is this Worker's.
   * @returns The issue as it was just before the change.
   */
  async setIssueStatus(issueId: string, status: IssueStatus): Promise<CloudflareWorkerIssue> {
    const before = await this.getIssue(issueId);
    await this.#request({
      method: "PATCH", path: `/workers/observability/issues/${encodeURIComponent(assertIssueId(issueId))}`,
      body: { status }, label: "issues.patch",
    });
    return before;
  }
}

/**
 * Whether these credentials can read a Worker's deployments, which is what a releases read reports
 * as `workerScriptSubresourceId`: false when Cloudflare denies access, throwing when it can't tell.
 */
export async function canReadWorkerScript(
  getToken: () => Promise<string | null>, accountId: string, workerName: string,
): Promise<boolean> {
  return probe(() => requestCloudflareApi(getToken, accountId, {
    method: "GET", path: `/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
    label: "deployments",
  }));
}

/**
 * Whether these credentials can read a Workers Builds build, which is what a releases read reports
 * as `workerBuildSubresourceId`: false when Cloudflare denies access, throwing when it can't tell.
 */
export async function canReadWorkerBuild(
  getToken: () => Promise<string | null>, accountId: string, buildUuid: string,
): Promise<boolean> {
  if (!UUID_PATTERN.test(buildUuid)) throw new Error("Invalid Workers Builds build ID.");
  return probe(() => requestCloudflareApi(getToken, accountId, {
    method: "GET", path: `/builds/builds/${encodeURIComponent(buildUuid)}`, label: "builds.get",
  }));
}

async function probe(read: () => Promise<unknown>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch (error) {
    if (deniesAccess(error)) return false;
    throw error;
  }
}
