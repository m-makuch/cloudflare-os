// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extraDashboardOrigins,
  isDashboardOrigin,
  parseWorkersIssueSetup,
  respondToWorkersIssueSetup,
  workersIssueSetupSearch,
} from "./workersIssueSetup";

const request = {
  state: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  accountId: "a".repeat(32),
  workerName: "checkout-test",
  issueId: "issue-1",
  dashboardOrigin: "https://dash.cloudflare.com",
};
const search = (value: unknown) =>
  new URLSearchParams({ workers_issue_setup: JSON.stringify(value) }).toString();
afterEach(() => vi.unstubAllEnvs());

describe("dashboard issue setup context", () => {
  it.each(["https://github.com/acme/checkout", "https://gitlab.com/acme/team/checkout"])(
    "preserves the editable repository hint through sign-in without opting into fixes: %s",
    (repositoryUrl) => {
      const value = { ...request, repositoryUrl };
      expect(workersIssueSetupSearch(search(value))).toEqual({ workers_issue_setup: value });
      expect(parseWorkersIssueSetup(search(value))).not.toHaveProperty("remediation");
    },
  );
  it.each([
    "javascript:alert(1)",
    "http://github.com/acme/checkout",
    "https://user:secret@github.com/acme/checkout",
    "https://github.com/acme/checkout?token=secret",
    "https://github.com/acme/checkout#secret",
    `https://example.test/${"a".repeat(300)}`,
    42,
  ])("rejects unsafe repository hints: %s", (repositoryUrl) =>
    expect(parseWorkersIssueSetup(search({ ...request, repositoryUrl }))).toBeNull(),
  );
  it.each(["http://localhost:3000", "https://127.0.0.1:7443", "http://[::1]:3000"])(
    "allows %s only in development builds",
    (dashboardOrigin) => {
      vi.stubEnv("DEV", true);
      expect(parseWorkersIssueSetup(search({ ...request, dashboardOrigin }))).not.toBeNull();
      vi.stubEnv("DEV", false);
      expect(parseWorkersIssueSetup(search({ ...request, dashboardOrigin }))).toBeNull();
      expect(parseWorkersIssueSetup(search(request))).toEqual(request);
    },
  );
  it("preserves the Worker and issue across sign-in without accepting unrelated parameters", () => {
    expect(parseWorkersIssueSetup(search(request))).toEqual(request);
    expect(workersIssueSetupSearch(`${search(request)}&redirect=https://evil.example`)).toEqual({
      workers_issue_setup: request,
    });
  });

  it.each([
    { ...request, dashboardOrigin: "https://dash.cloudflare.com.evil.example" },
    { ...request, dashboardOrigin: "https://dash.cloudflare.com/path" },
    { ...request, dashboardOrigin: "https://evil.example" },
    { ...request, accountId: "../another-account" },
    { ...request, workerName: "../another-worker" },
    { ...request, state: "" },
  ])("rejects an invalid or misdirected setup request", (value) => {
    expect(parseWorkersIssueSetup(search(value))).toBeNull();
  });

  it("preserves a fix request only alongside an investigation, and rejects malformed ones", () => {
    const investigation = { workspaceId: "b".repeat(64), destinationId: "destination-1" };
    const remediation = { allowPublic: false, repositoryUrl: "https://github.com/acme/checkout" };
    const value = { ...request, investigation, remediation };
    expect(parseWorkersIssueSetup(search(value))).toEqual(value);
    // An older dashboard's per-change approval choice no longer applies.
    expect(
      parseWorkersIssueSetup(
        search({ ...value, remediation: { ...remediation, approval: "ask" } }),
      ),
    ).toEqual(value);
    expect(parseWorkersIssueSetup(search({ ...request, remediation }))).toBeNull();
    for (const bad of [
      { ...remediation, allowPublic: "yes" },
      { ...remediation, repositoryUrl: "javascript:alert(1)" },
      { ...remediation, repositoryUrl: "http://github.com/acme/checkout" },
    ]) {
      expect(
        parseWorkersIssueSetup(search({ ...request, investigation, remediation: bad })),
      ).toBeNull();
    }
  });

  it("accepts an inbox request only for investigations, with one run key of its own account", () => {
    const { dashboardOrigin: _dashboard, issueId: _issue, ...inbox } = request;
    const investigation = { workspaceId: "b".repeat(64), destinationId: "destination-1" };
    const runKey = `${request.accountId}:run-1`;
    const value = { ...inbox, investigation, runKey };
    expect(parseWorkersIssueSetup(search(value))).toEqual(value);
    expect(parseWorkersIssueSetup(search({ ...inbox, investigation }))).toEqual({
      ...inbox,
      investigation,
    });
    // Connecting a destination always starts from the dashboard.
    expect(parseWorkersIssueSetup(search(inbox))).toBeNull();
    for (const bad of [
      { ...value, runKey: `${"c".repeat(32)}:run-1` },
      { ...value, runKey: `${request.accountId}:../run` },
      { ...value, runKey: 1 },
      { ...value, dashboardOrigin: request.dashboardOrigin },
      { ...inbox, runKey },
    ]) {
      expect(parseWorkersIssueSetup(search(bad))).toBeNull();
    }
  });

  it("rejects duplicate and oversized setup parameters", () => {
    expect(parseWorkersIssueSetup(`${search(request)}&${search(request)}`)).toBeNull();
    expect(parseWorkersIssueSetup(search({ ...request, extra: "x".repeat(2048) }))).toBeNull();
  });

  it("preserves a bounded optional investigator request through authentication", () => {
    const value = {
      ...request,
      investigation: { workspaceId: "b".repeat(64), destinationId: "destination-1" },
    };
    expect(parseWorkersIssueSetup(search(value))).toEqual(value);
    expect(workersIssueSetupSearch(search(value))).toEqual({
      workers_issue_setup: value,
    });
    expect(
      parseWorkersIssueSetup(
        search({ ...value, investigation: { ...value.investigation, workspaceId: "../other" } }),
      ),
    ).toBeNull();
    expect(
      parseWorkersIssueSetup(search({ ...value, investigation: { workspaceId: "b".repeat(64) } })),
    ).toBeNull();
  });

  it("answers only a matching dashboard poll and stops answering on cleanup", () => {
    const postMessage = vi.fn<Window["postMessage"]>();
    const source = { postMessage } as unknown as Window;
    const result = { destinationId: "destination-1", workspaceId: "b".repeat(64) };
    const cleanup = respondToWorkersIssueSetup(request, result);
    const poll = (origin: string, state = request.state) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: { type: "cloudflare-os:workers-issues:status", state },
        }),
      );
    poll("https://evil.example");
    poll(request.dashboardOrigin, "wrong-state");
    expect(postMessage).not.toHaveBeenCalled();
    poll(request.dashboardOrigin);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "cloudflare-os:workers-issues:ready",
        state: request.state,
        accountId: request.accountId,
        ...result,
      },
      { targetOrigin: request.dashboardOrigin },
    );
    cleanup();
    poll(request.dashboardOrigin);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("closes only after acceptance from the matching dashboard that polled for completion", () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const dashboard = { postMessage: vi.fn<Window["postMessage"]>() } as unknown as Window;
    const other = { postMessage: vi.fn<Window["postMessage"]>() } as unknown as Window;
    const cleanup = respondToWorkersIssueSetup(request, {
      destinationId: "destination-1",
      workspaceId: "b".repeat(64),
    });
    const send = (
      type: string,
      source = dashboard,
      origin = request.dashboardOrigin,
      state = request.state,
    ) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          source,
          data: { type: `cloudflare-os:workers-issues:${type}`, state },
        }),
      );
    try {
      send("accepted");
      expect(close).not.toHaveBeenCalled();
      send("status");
      send("accepted", other);
      send("accepted", dashboard, "https://evil.example");
      send("accepted", dashboard, request.dashboardOrigin, "wrong-state");
      expect(close).not.toHaveBeenCalled();
      send("accepted");
      send("accepted");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      close.mockRestore();
    }
  });
});

describe("extra dashboard origins for a test deployment", () => {
  it("accepts only exact HTTPS origins, and trusts nothing extra by default", () => {
    expect(extraDashboardOrigins(undefined)).toEqual([]);
    expect(
      extraDashboardOrigins(
        " https://localhost:7445 ,http://localhost:7445,https://localhost:7445/path,*,javascript:x,https://dash.example.test",
      ),
    ).toEqual(["https://localhost:7445", "https://dash.example.test"]);
  });

  it("trusts a listed origin exactly, never a lookalike", () => {
    const extra = extraDashboardOrigins("https://dash.example.test:7445");
    expect(isDashboardOrigin("https://dash.example.test:7445", extra)).toBe(true);
    expect(isDashboardOrigin("https://dash.example.test:7446", extra)).toBe(false);
    expect(isDashboardOrigin("https://dash.example.test:7445/", extra)).toBe(false);
    expect(isDashboardOrigin("http://dash.example.test:7445", extra)).toBe(false);
    expect(isDashboardOrigin("https://dash.example.test:7445", [])).toBe(false);
    expect(isDashboardOrigin("https://dash.cloudflare.com", [])).toBe(true);
  });
});
