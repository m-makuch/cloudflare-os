// The collaborator ACL: verifyObserverAccess() for the account every read reports, and
// addObserver(), which still checks each binding as before reads reported one. The deny path, and
// the refusal to treat an infrastructure failure as a denial, are both asserted here.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_SCOPES } from "../../src/oauth";
import { WORKER_RELEASES_RESOURCE, WORKER_RELEASES_SCOPES } from "../../src/resources";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WORKER_PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID, workerName: "api-worker" };
const ACCOUNT_PROPS = { userObjectId: "user-1", accountId: ACCOUNT_ID };
const ACCOUNT_SUBRESOURCE = `account/${ACCOUNT_ID}`;

// Each case gets its own facet name: a facet is cached per name, so reusing one would silently reuse
// the first case's props.
const hooks = env.TEST_HOOKS.getByName("hooks");

describe("addObserver", () => {
  it("admits a collaborator whose own credentials can read the binding", async () => {
    expect(await hooks.addObserver("admit", WORKER_PROPS, true)).toBeNull();
  });

  it("refuses a collaborator whose own credentials cannot", async () => {
    expect(await hooks.addObserver("deny", WORKER_PROPS, false))
      .toMatch(/does not have access to the bound Workers telemetry/);
  });

  it("refuses rather than admits when the verification itself fails", async () => {
    // The dangerous direction: a 5xx or transport failure must not become "allowed". It surfaces as
    // an error, so sharing fails loudly instead of silently granting access.
    const message = await hooks.addObserver("explode", WORKER_PROPS, "verifier exploded");

    expect(message).not.toBeNull();
    expect(message).toContain("verifier exploded");
  });
});

describe("verifyObserverAccess", () => {
  it("allows only observers whose own credentials can read the account, even on a Worker binding", async () => {
    const { result, asked } = await hooks.verifyObserverAccess("verify",
      WORKER_PROPS, { allowed: true, denied: false }, [ACCOUNT_SUBRESOURCE]);

    expect(result).toEqual(["allowed"]);
    // The account itself is asked about, not the binding's Worker.
    expect(asked).toEqual({ allowed: [ACCOUNT_ID], denied: [ACCOUNT_ID] });
  });

  it("fails the whole call when an observer's access cannot be determined", async () => {
    const { result } = await hooks.verifyObserverAccess("verify-explode",
      ACCOUNT_PROPS, { allowed: true, broken: "verifier exploded" }, [ACCOUNT_SUBRESOURCE]);

    expect(result).toContain("verifier exploded");
  });

  it("refuses an ID it never reports without asking anyone", async () => {
    const { result, asked } = await hooks.verifyObserverAccess("verify-unknown", ACCOUNT_PROPS,
      { observer: true }, [ACCOUNT_SUBRESOURCE, `${ACCOUNT_SUBRESOURCE}/worker/${"a".repeat(32)}`]);

    expect(result).toContain("Not a Cloudflare Workers Observability subresource");
    expect(asked).toEqual({ observer: [] });
  });
});

describe("resource description", () => {
  it("describes a Worker binding with its Worker-scoped dashboard URL", async () => {
    const described = await hooks.describeResource("describe-worker", WORKER_PROPS);

    expect(described.url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api-worker/production/observability`);
    expect(described.title).toBe("api-worker observability");
    expect(described.suggestedBindingName).toBe("WORKER_OBSERVABILITY");
  });

  it("describes an account binding with the account-wide URL", async () => {
    const described = await hooks.describeResource("describe-account", ACCOUNT_PROPS);

    expect(described.url)
      .toBe(`https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages/observability`);
    expect(described.title).toBe("Workers Observability");
    expect(described.suggestedBindingName).toBe("CLOUDFLARE_OBSERVABILITY");
  });
});

describe("read-only enforcement", () => {
  it("refuses to apply an action", async () => {
    expect(await hooks.applyActionMessage("apply", WORKER_PROPS)).toContain("read-only");
  });

  it("offers no auto-approvable action on either observability binding", async () => {
    // The Worker observability binding is held by an investigating agent, which must never be
    // able to resolve an issue: that is the releases binding's alone.
    expect(await hooks.observabilityAutoApprovable("kinds-worker", WORKER_PROPS)).toEqual([]);
    expect(await hooks.observabilityAutoApprovable("kinds-account", ACCOUNT_PROPS)).toEqual([]);
  });

  it("keeps describing the Worker observability binding as the read-only session", async () => {
    expect(await hooks.describeResource("describe-worker-again", WORKER_PROPS)).toMatchObject({
      suggestedBindingName: "WORKER_OBSERVABILITY",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Worker releases

const ISSUE = {
  id: "issue-1", service: "api-worker", title: "TypeError: x is undefined", type: "exception",
  status: "active", statusUpdated: 1, count: 3, firstObserved: 1, lastObserved: 2,
};
const BUILD = "dddddddd-0000-4000-8000-000000000004";

let users = 0;

/** A connected account holding `scopes`, for a gatekeeper's `userObjectId`. */
async function connectedUser(scopes = [...BILLING_SCOPES, ...WORKER_RELEASES_SCOPES]): Promise<string> {
  const stub = env.USER_ACCOUNT.getByName(`releases-user-${users++}`);
  await runInDurableObject(stub, (_account, state) => {
    state.storage.kv.put("refreshToken", "refresh-1");
    state.storage.kv.put("accessToken", { token: "access-1", expires: Date.now() + 24 * 60 * 60_000 });
    state.storage.kv.put("grantedScopes", scopes);
  });
  return stub.id.toString();
}

/** Stubs the issues API with one issue whose status PATCHes change; returns the requests. */
function stubIssue(issue: Record<string, unknown> = ISSUE) {
  const state = { ...issue };
  const requests: { method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (!url.pathname.endsWith(`/workers/observability/issues/${String(issue.id)}`)) {
      return Response.json({ success: false }, { status: 404 });
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init.method ?? "GET", ...(body ? { body } : {}) });
    if (init.method === "PATCH") Object.assign(state, body);
    return Response.json({ success: true, result: { issue: { ...state } } });
  }));
  return { state, requests };
}

async function releasesProps() {
  return { userObjectId: await connectedUser(), accountId: ACCOUNT_ID, workerName: "api-worker" };
}

describe("Worker releases", () => {
  beforeEach(async () => { await hooks.resetReleasesLog(); });
  afterEach(() => vi.unstubAllGlobals());

  it("describes itself as the releases binding", async () => {
    expect(await hooks.describeReleases("releases-describe", await releasesProps())).toEqual({
      url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api-worker/production/deployments`,
      title: "api-worker releases",
      suggestedBindingName: "WORKER_RELEASES",
      tsType: "CloudflareWorkerReleases",
    });
  });

  it("offers exactly the resolve kind for auto-approval", async () => {
    expect(await hooks.releasesAutoApprovable("releases-kinds", await releasesProps()))
      .toEqual([{ tag: "resolve-worker-issue", label: "Resolve Worker issues" }]);
  });

  it("stages a resolve, simulates it, applies it, and reverts it", async () => {
    const props = await releasesProps();
    const { state, requests } = stubIssue();

    expect(await hooks.releasesSession("releases-flow", props, { method: "resolveIssue", issueId: "issue-1" }))
      .toEqual({ result: undefined });
    const { submitted } = await hooks.releasesLog();
    expect(submitted).toHaveLength(1);
    const [{ id, description }] = submitted;
    expect(description).toMatchObject({
      autoApprovable: true,
      actionKind: { tag: "resolve-worker-issue", label: "Resolve Worker issues" },
      implementsRevert: true,
    });
    expect(description.awaitDecision).toBeUndefined();
    expect(description.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Issue", value: "issue-1" }),
      expect.objectContaining({ label: "Title", value: "TypeError: x is undefined" }),
      expect.objectContaining({ label: "Status", value: "active → resolved" }),
    ]));
    // Nothing reached Cloudflare but the read.
    expect(requests.map(request => request.method)).toEqual(["GET"]);

    // Later reads see it resolved, though Cloudflare does not yet, and asking again stages nothing.
    expect((await hooks.releasesSession("releases-flow", props, { method: "getIssue", issueId: "issue-1" })).result)
      .toMatchObject({ status: "resolved" });
    await hooks.releasesSession("releases-flow", props, { method: "resolveIssue", issueId: "issue-1" });
    expect((await hooks.releasesLog()).submitted).toHaveLength(1);
    expect(state.status).toBe("active");

    expect(await hooks.releasesDecide("releases-flow", props, "apply", id)).toEqual({ result: undefined });
    expect(state.status).toBe("resolved");
    expect(requests.filter(request => request.method === "PATCH")).toEqual([
      { method: "PATCH", body: { status: "resolved" } },
    ]);

    expect(await hooks.releasesDecide("releases-flow", props, "revert", id)).toEqual({ result: undefined });
    expect(state.status).toBe("active");
    expect(requests.filter(request => request.method === "PATCH").at(-1))
      .toEqual({ method: "PATCH", body: { status: "active" } });
    // Reverted is final.
    expect((await hooks.releasesDecide("releases-flow", props, "revert", id)).result)
      .toMatchObject({ canRetry: false });
  });

  it("drops the simulation when the resolve is rejected", async () => {
    const props = await releasesProps();
    stubIssue();

    await hooks.releasesSession("releases-reject", props, { method: "resolveIssue", issueId: "issue-1" });
    const [{ id }] = (await hooks.releasesLog()).submitted;
    await hooks.releasesDecide("releases-reject", props, "reject", id);

    expect((await hooks.releasesSession("releases-reject", props, { method: "getIssue", issueId: "issue-1" })).result)
      .toMatchObject({ status: "active" });
  });

  it("leaves an issue that recurred after the resolve alone on revert", async () => {
    const props = await releasesProps();
    const { state, requests } = stubIssue();

    await hooks.releasesSession("releases-recur", props, { method: "resolveIssue", issueId: "issue-1" });
    const [{ id }] = (await hooks.releasesLog()).submitted;
    await hooks.releasesDecide("releases-recur", props, "apply", id);
    state.status = "active";

    expect((await hooks.releasesDecide("releases-recur", props, "revert", id)).result)
      .toMatchObject({ message: expect.stringContaining("active") });
    expect(requests.filter(request => request.method === "PATCH")).toHaveLength(1);
  });

  it("refuses at apply an issue that has since become another Worker's", async () => {
    const props = await releasesProps();
    const { state, requests } = stubIssue();

    await hooks.releasesSession("releases-moved", props, { method: "resolveIssue", issueId: "issue-1" });
    const [{ id }] = (await hooks.releasesLog()).submitted;
    state.service = "other-worker";

    expect((await hooks.releasesDecide("releases-moved", props, "apply", id)).error)
      .toContain("not an issue of this Worker");
    expect(requests.filter(request => request.method === "PATCH")).toEqual([]);
  });

  it("checks each subresource with the observer's own connection", async () => {
    const props = await releasesProps();
    const ids = [
      ACCOUNT_SUBRESOURCE,
      `${ACCOUNT_SUBRESOURCE}/workers-script/api-worker`,
      `${ACCOUNT_SUBRESOURCE}/workers-build/${BUILD}`,
    ];

    const { result, asked } = await hooks.verifyReleasesAccess("releases-verify", props,
      { allowed: true, denied: false }, ids);

    expect(result).toEqual(["allowed"]);
    expect(asked).toEqual({ allowed: ids, denied: ids });
  });

  it("refuses an ID naming another Worker or account without asking anyone", async () => {
    const props = await releasesProps();
    for (const id of [
      `${ACCOUNT_SUBRESOURCE}/workers-script/other-worker`,
      `account/${"f".repeat(32)}`,
      `${ACCOUNT_SUBRESOURCE}/worker/api-worker`,
    ]) {
      const { result, asked } = await hooks.verifyReleasesAccess("releases-verify-foreign", props,
        { observer: true }, [id]);
      expect(typeof result, id).toBe("string");
      expect(asked).toEqual({ observer: [] });
    }
  });

  it("has no legacy history to export, being a new resource kind", async () => {
    expect(await hooks.releasesHistoricalSubresources("releases-history", await releasesProps())).toEqual([]);
  });
});

describe("Worker releases grants", () => {
  const releasesUrl =
    `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api-worker/production/deployments`;

  it("asks an observability-only connection to consent to the releases scopes", async () => {
    const userObjectId = await connectedUser([...BILLING_SCOPES, "workers-observability.read"]);

    const { url } = await hooks.ensureResources(userObjectId, [WORKER_RELEASES_RESOURCE.urlPattern]);

    expect(url).toBeTruthy();
    const requested = await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId)),
      (_account, state) => state.storage.kv.get<string[]>("scopes"));
    expect(requested).toEqual(expect.arrayContaining(WORKER_RELEASES_SCOPES));
    expect(await hooks.resourceFor(userObjectId, releasesUrl)).toContain("Reconnect Cloudflare");
  });

  it("binds without asking once every releases scope is granted", async () => {
    const userObjectId = await connectedUser();

    expect(await hooks.ensureResources(userObjectId, [WORKER_RELEASES_RESOURCE.urlPattern])).toEqual({});
    expect(await hooks.resourceFor(userObjectId, releasesUrl)).toBe(WORKER_RELEASES_RESOURCE.urlPattern);
  });
});
