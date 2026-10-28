// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
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

describe("dashboard issue setup context", () => {
  it("preserves the Worker and issue across sign-in without accepting unrelated parameters", () => {
    expect(parseWorkersIssueSetup(search(request))).toEqual(request);
    expect(workersIssueSetupSearch(`${search(request)}&redirect=https://evil.example`)).toEqual({
      workers_issue_setup: JSON.stringify(request),
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
      workers_issue_setup: JSON.stringify(value),
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
});
