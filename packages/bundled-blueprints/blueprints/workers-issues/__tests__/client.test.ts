import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Investigation, WorkerIssueInbox } from "../files/lib/protocol.ts";

const entry = (overrides: Partial<Investigation> = {}): Investigation => ({
  run_key: "account:run-1",
  issue_id: "issue-1",
  status: "received",
  report: null,
  created_at: 1_790_000_000_000,
  ...overrides,
});

const listInvestigations = vi.fn<WorkerIssueInbox["listInvestigations"]>();
const getSetupStatus = vi.fn<WorkerIssueInbox["getSetupStatus"]>();

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.head.replaceChildren();
  document.body.replaceChildren();
  listInvestigations.mockReset().mockResolvedValue([entry()]);
  getSetupStatus.mockReset().mockResolvedValue({
    accountId: "a".repeat(32),
    workerName: "checkout-test",
    investigationsEnabled: false,
  });
  vi.stubGlobal("gadget", { listInvestigations, getSetupStatus });
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load(): Promise<void> {
  await import("../files/client.ts");
  await vi.advanceTimersByTimeAsync(0);
}

describe("Worker issue inbox", () => {
  it("presents notification-only mode and untrusted report text without executing markup", async () => {
    listInvestigations.mockResolvedValue([entry({
      status: "completed",
      report: '<img src="invalid" onerror="alert(1)">',
    })]);
    await load();

    expect(document.body.textContent).toContain("Notifications only");
    expect(document.body.textContent).toContain("checkout-test");
    expect(document.body.textContent).toContain("Report ready");
    expect(document.querySelector("button")?.textContent).toBe("Refresh inbox");
    expect(document.querySelector(".report")?.textContent).toContain("<img");
    expect(document.querySelector("img")).toBeNull();
  });

  it("preserves selected report text through unchanged polls and insertion of newer entries", async () => {
    const original = entry({ status: "completed", report: "Read this report without interruption." });
    listInvestigations.mockResolvedValue([original]);
    await load();
    const article = document.querySelector("article")!;
    const report = article.querySelector(".report")!;
    const text = report.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(report);
    window.getSelection()!.addRange(range);

    listInvestigations.mockResolvedValue([
      entry({ run_key: "account:run-2", created_at: original.created_at + 1000 }),
      original,
    ]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(document.querySelectorAll("article")[1]).toBe(article);
    expect(report.firstChild).toBe(text);
    expect(window.getSelection()!.toString()).toBe(original.report);
  });

  it("keeps separate runs of the same issue distinct and updates only the changed report", async () => {
    const first = entry({ status: "completed", report: "First occurrence" });
    const second = entry({ run_key: "account:run-2", status: "queued" });
    listInvestigations.mockResolvedValue([second, first]);
    await load();
    const articles = [...document.querySelectorAll("article")];
    expect(articles).toHaveLength(2);

    listInvestigations.mockResolvedValue([
      { ...second, status: "completed", report: "Second occurrence" }, first,
    ]);
    await vi.advanceTimersByTimeAsync(5000);

    expect([...document.querySelectorAll("article")]).toEqual(articles);
    expect(articles[0].textContent).toContain("Second occurrence");
    expect(articles[1].textContent).toContain("First occurrence");
  });

  it("keeps loaded notifications visible on refresh failure and recovers on manual refresh", async () => {
    await load();
    const article = document.querySelector("article");
    listInvestigations.mockRejectedValueOnce(new Error("Disconnected"));
    await vi.advanceTimersByTimeAsync(5000);

    const alert = document.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("Showing the last loaded notifications");
    expect(document.querySelector("article")).toBe(article);

    document.querySelector("button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(alert.hidden).toBe(true);
    expect(document.querySelector("article")).toBe(article);
  });

  it("shows an initial load failure rather than claiming no notifications exist", async () => {
    listInvestigations.mockRejectedValue(new Error("Disconnected"));
    await load();

    expect(document.querySelector<HTMLElement>(".empty")!.hidden).toBe(true);
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Inbox unavailable.");
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Could not load");
  });

  it("shows the empty inbox and AI mode, and stops polling after the page closes", async () => {
    listInvestigations.mockResolvedValue([]);
    getSetupStatus.mockResolvedValue({ workerName: "checkout-test", investigationsEnabled: true });
    await load();

    expect(document.querySelector<HTMLElement>(".empty")!.hidden).toBe(false);
    expect(document.body.textContent).toContain("AI investigations on");
    expect(document.body.textContent).toContain("Waiting for an issue notification");
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listInvestigations).toHaveBeenCalledTimes(1);
  });
});
