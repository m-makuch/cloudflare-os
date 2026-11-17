// Covers the guarantee the README makes and nothing previously tested: every read a session returns
// is recorded on the approval queue. Deleting the `authorizeObservation` await in
// `observability-session.ts` must fail this file.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareObservabilityApi } from "../../src/observability-api";
import { CloudflareWorkerReleasesApi } from "../../src/releases-api";
import type { ResolveIssue } from "../../src/releases-actions";
import { CloudflareWorkerReleasesSessionImpl } from "../../src/releases-session";
import {
  CloudflareObservabilitySessionImpl,
  summarizeFilter,
} from "../../src/observability-session";
import type { CloudflareObservabilityFilter } from "../../src/types";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TEST_NOW = new Date("2026-08-14T12:00:00Z");

type Observation = { title: string; description: string; subresources?: string[] };

const ACCOUNT_SUBRESOURCE = `account/${ACCOUNT_ID}`;

class TestApprovalQueue extends RpcTarget {
  readonly observations: Observation[] = [];
  disposed = 0;

  async authorizeObservation(entry: Observation): Promise<void> {
    this.observations.push(entry);
  }

  [Symbol.dispose](): void {
    this.disposed++;
  }
}

const STATISTICS = { elapsed: 1, rows_read: 10, bytes_read: 100 };

function event(id: string, service = "api-worker") {
  return {
    dataset: "cloudflare-workers",
    timestamp: TEST_NOW.valueOf(),
    source: { message: "hello" },
    $metadata: { id, service, level: "info", traceId: "trace-1" },
  };
}

/** One provider response for every view the session can request. */
function stubProvider() {
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const result: Record<string, unknown> = { statistics: STATISTICS };
    if (body.view === "events") result.events = { count: 1, events: [event("e1")] };
    if (body.view === "invocations") result.invocations = { "req-1": [event("e1")] };
    if (body.view === "traces") {
      result.traces = [{
        traceId: "trace-1", traceStartMs: 1, traceEndMs: 2, traceDurationMs: 1,
        rootSpanName: "fetch", rootTransactionName: "GET /", service: ["api-worker"], spans: 1,
      }];
    }
    if (body.view === "calculations") {
      result.calculations = [{
        calculation: "count",
        aggregates: [{ value: 1, count: 1, interval: 1, sampleInterval: 1 }],
        series: [],
      }];
    }
    if (body.key !== undefined) {
      return Response.json({ success: true, result: [{ key: body.key, type: "string", value: "x", dataset: "cloudflare-workers" }] });
    }
    if (body.view === undefined) {
      return Response.json({ success: true, result: [{ key: "$metadata.level", type: "string", lastSeenAt: 1 }] });
    }
    return Response.json({ success: true, result });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function newSession() {
  const queue = new TestApprovalQueue();
  const api = new CloudflareObservabilityApi(async () => "token", ACCOUNT_ID);
  const session = new CloudflareObservabilitySessionImpl(
    api, new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>,
    `Cloudflare account ${ACCOUNT_ID}`, ACCOUNT_SUBRESOURCE,
  );
  return { queue, session };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("observation authorization", () => {
  // Parameterized so a method added later without an `#observe` wrapper is a visible omission here
  // rather than a silent gap.
  const reads: Array<[string, (session: CloudflareObservabilitySessionImpl) => Promise<unknown>]> = [
    ["listKeys", session => session.listKeys()],
    ["listValues", session => session.listValues("$metadata.level", "string")],
    ["listEvents", session => session.listEvents()],
    ["listInvocations", session => session.listInvocations()],
    ["listTraces", session => session.listTraces()],
    ["getTrace", session => session.getTrace("trace-1")],
    ["calculate", session => session.calculate({ calculations: [{ operator: "count" }] })],
  ];

  it.each(reads)("%s records exactly one observation, reporting the binding", async (_name, read) => {
    stubProvider();
    const { queue, session } = newSession();

    await read(session);

    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.title).toBeTruthy();
    expect(queue.observations[0]!.description).toContain(ACCOUNT_ID);
    expect(queue.observations[0]!.subresources).toEqual([ACCOUNT_SUBRESOURCE]);
  });

  it("records the observation even when the read returned nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ success: true, result: { statistics: STATISTICS, events: { count: 0, events: [] } } })));
    const { queue, session } = newSession();

    await session.listEvents();

    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.description).toContain("returned 0 events");
    // An empty answer still says something about the account, so it is checked like any other.
    expect(queue.observations[0]!.subresources).toEqual([ACCOUNT_SUBRESOURCE]);
  });

  it("does not record an observation when the read failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      Response.json({ success: false, errors: [{ message: "nope" }] }, { status: 403 })));
    const { queue, session } = newSession();

    await expect(session.listEvents()).rejects.toThrow(/403|nope/);
    expect(queue.observations).toEqual([]);
  });

  it("reports scan cost so an approver can see what a read consumed", async () => {
    stubProvider();
    const { queue, session } = newSession();

    await session.listEvents();

    expect(queue.observations[0]!.description).toContain("10 rows and 100 bytes scanned");
  });
});

describe("session lifetime", () => {
  it("releases the approval queue when disposed", async () => {
    stubProvider();
    const { session } = newSession();

    session[Symbol.dispose]();

    // Released means the queue stub is gone, so no further read can be authorized -- and since
    // `#observe` authorizes before returning, no further read can succeed either.
    await expect(session.listEvents()).rejects.toThrow();
  });

  it("authorizes reads right up until it is disposed", async () => {
    stubProvider();
    const { queue, session } = newSession();

    await session.listEvents();
    session[Symbol.dispose]();

    expect(queue.observations).toHaveLength(1);
  });
});

describe("approval descriptions", () => {
  it("names the fields and operations read, and never the caller's values", () => {
    const filter: CloudflareObservabilityFilter = {
      kind: "group",
      filterCombination: "and",
      filters: [
        { kind: "filter", key: "$metadata.level", operation: "eq", type: "string", value: "secret-value" },
        { kind: "filter", key: "$metadata.statusCode", operation: "gte", type: "number", value: 500 },
      ],
    };

    const summary = summarizeFilter(filter);

    expect(summary).toBe("$metadata.level eq, $metadata.statusCode gte");
    expect(summary).not.toContain("secret-value");
  });

  it("marks an OR combination so the entry is not read as a conjunction", () => {
    expect(summarizeFilter({
      kind: "group",
      filterCombination: "or",
      filters: [
        { kind: "filter", key: "a", operation: "exists", type: "string" },
        { kind: "filter", key: "b", operation: "exists", type: "string" },
      ],
    })).toBe("a exists or b exists");
  });

  it("bounds a large filter rather than pasting it into the queue", () => {
    const summary = summarizeFilter({
      kind: "group",
      filterCombination: "and",
      filters: Array.from({ length: 30 }, (_unused, index) => ({
        kind: "filter" as const,
        key: `field${index}`,
        operation: "exists" as const,
        type: "string" as const,
      })),
    });

    expect(summary).toMatch(/, \.\.\.$/);
    expect(summary.split(",").length).toBeLessThanOrEqual(7);
  });

  it("says so when there is no filter", () => {
    expect(summarizeFilter()).toBe("none");
  });
});

const ok = (result: unknown) => Response.json({ success: true, result });
const getToken = async () => "token";

describe("Worker releases observations", () => {
  const VERSION_A = "aaaaaaaa-0000-4000-8000-000000000001";
  const BUILD_A = "dddddddd-0000-4000-8000-000000000004";
  const SCRIPT_SUBRESOURCE = `account/${ACCOUNT_ID}/workers-script/api-worker`;
  const ISSUE = {
    id: "issue-1", service: "api-worker", title: "TypeError: secret-title", type: "exception",
    status: "active", statusUpdated: 1, count: 3, firstObserved: 1, lastObserved: 2,
  };

  /** Stubs Cloudflare for every releases read; `builds` controls the Workers Builds answer. */
  function stubReleases(options: { builds?: "commit" | "none"; issue?: Record<string, unknown> } = {}) {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      requests.push(`${init.method} ${url.pathname}`);
      if (url.pathname.endsWith("/deployments")) {
        return ok({ deployments: [{
          id: "dep-1", source: "wrangler", created_on: "2026-08-14T11:00:00Z",
          annotations: { "workers/message": "secret-deploy-message" },
          versions: [{ version_id: VERSION_A, percentage: 100 }],
        }] });
      }
      if (url.pathname.includes("/versions/")) {
        return ok({ id: VERSION_A, annotations: { "workers/tag": "secret-tag" } });
      }
      if (url.pathname.endsWith("/builds/builds")) {
        return ok({ builds: options.builds === "commit" ? { [VERSION_A]: {
          build_uuid: BUILD_A, build_trigger_metadata: { branch: "main", commit_hash: "c0ffee" },
        } } : {} });
      }
      if (url.pathname.includes("/workers/observability/issues/")) return ok({ issue: options.issue ?? ISSUE });
      if (url.pathname.endsWith("/telemetry/query")) {
        return ok({ statistics: STATISTICS, calculations: [{
          calculation: "uniq", aggregates: [{ value: 987654, count: 1, interval: 1, sampleInterval: 1 }], series: [],
        }] });
      }
      return Response.json({ success: false }, { status: 404 });
    }));
    return requests;
  }

  function newReleasesSession(pending = new Map<string, number>()) {
    const queue = new TestApprovalQueue();
    const submitted: ResolveIssue[] = [];
    const session = new CloudflareWorkerReleasesSessionImpl({
      accountId: ACCOUNT_ID,
      workerName: "api-worker",
      releases: new CloudflareWorkerReleasesApi(getToken, ACCOUNT_ID, "api-worker"),
      telemetry: new CloudflareObservabilityApi(getToken, ACCOUNT_ID, "api-worker"),
      pendingResolves: () => pending,
      submitResolve: async (_queue, payload) => { submitted.push(payload); },
    }, new RpcStub(queue) as unknown as RpcStub<ApprovalQueue>);
    return { queue, session, submitted };
  }

  it("reports the Worker's script for deployments, and each build whose commit it returned", async () => {
    stubReleases({ builds: "commit" });
    const { queue, session } = newReleasesSession();

    const [deployment] = await session.listDeployments();

    expect(deployment!.versions[0]).toEqual({
      versionId: VERSION_A, percentage: 100, tag: "secret-tag", commit: "c0ffee", branch: "main",
    });
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.subresources).toEqual([
      SCRIPT_SUBRESOURCE, `account/${ACCOUNT_ID}/workers-build/${BUILD_A}`,
    ]);
    // What was read is named; what it said is not.
    expect(queue.observations[0]!.description).toContain("api\\-worker");
    for (const secret of ["secret-tag", "c0ffee", "secret-deploy-message", "main"]) {
      expect(JSON.stringify(queue.observations[0]), secret).not.toContain(secret);
    }
  });

  it("reports only the script when no build data was returned", async () => {
    stubReleases({ builds: "none" });
    const { queue, session } = newReleasesSession();

    const [deployment] = await session.listDeployments({ limit: 1 });

    expect(deployment!.versions[0]).not.toHaveProperty("commit");
    expect(queue.observations[0]!.subresources).toEqual([SCRIPT_SUBRESOURCE]);
  });

  it("reports the account for an invocation count, and leaves the count out of the audit", async () => {
    stubReleases();
    const { queue, session } = newReleasesSession();

    expect(await session.countInvocations(VERSION_A, TEST_NOW.valueOf() - 60_000)).toBe(987654);

    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.subresources).toEqual([ACCOUNT_SUBRESOURCE]);
    expect(queue.observations[0]!.description).not.toContain("987654");
    expect(queue.observations[0]!.description).not.toContain(VERSION_A);
  });

  it("reports the account for an issue read, and leaves the issue's text out of the audit", async () => {
    stubReleases();
    const { queue, session } = newReleasesSession();

    expect(await session.getIssue("issue-1")).toMatchObject({ id: "issue-1", status: "active" });

    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.subresources).toEqual([ACCOUNT_SUBRESOURCE]);
    expect(JSON.stringify(queue.observations[0])).not.toContain("secret-title");
  });

  it("shows a pending resolve on later reads, reporting the same subresource", async () => {
    stubReleases();
    const { queue, session } = newReleasesSession(new Map([["issue-1", 1234]]));

    expect(await session.getIssue("issue-1")).toMatchObject({ status: "resolved", statusUpdated: 1234 });
    expect(queue.observations[0]!.subresources).toEqual([ACCOUNT_SUBRESOURCE]);
  });

  it("refuses an issue of another Worker without observing or submitting anything", async () => {
    stubReleases({ issue: { ...ISSUE, service: "other-worker" } });
    const { queue, session, submitted } = newReleasesSession();

    await expect(session.getIssue("issue-1")).rejects.toThrow("not an issue of this Worker");
    await expect(session.resolveIssue("issue-1")).rejects.toThrow("not an issue of this Worker");
    expect(queue.observations).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it("stages a resolve without observing, and only once", async () => {
    const requests = stubReleases();
    const { queue, session, submitted } = newReleasesSession();

    await session.resolveIssue("issue-1");

    expect(submitted).toEqual([{
      issueId: "issue-1", title: "TypeError: secret-title", statusAtSubmit: "active", stagedAt: TEST_NOW.valueOf(),
    }]);
    expect(queue.observations).toEqual([]);
    expect(requests.some(request => request.startsWith("PATCH"))).toBe(false);
  });

  it("does nothing for an issue already resolved or pending resolution", async () => {
    stubReleases({ issue: { ...ISSUE, status: "resolved" } });
    const resolved = newReleasesSession();
    await resolved.session.resolveIssue("issue-1");
    expect(resolved.submitted).toEqual([]);

    stubReleases();
    const pending = newReleasesSession(new Map([["issue-1", 1]]));
    await pending.session.resolveIssue("issue-1");
    expect(pending.submitted).toEqual([]);
  });

  it("validates IDs before reading anything", async () => {
    const requests = stubReleases();
    const { queue, session } = newReleasesSession();

    await expect(session.getIssue("../other")).rejects.toThrow("issue ID");
    await expect(session.resolveIssue("a b")).rejects.toThrow("issue ID");
    await expect(session.countInvocations("v1", 0)).rejects.toThrow("version ID");
    expect(requests).toEqual([]);
    expect(queue.observations).toEqual([]);
  });
});
