import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvestigationSummary, WorkerIssueInbox } from "../files/lib/protocol.ts";

const entry = (overrides: Partial<InvestigationSummary> = {}): InvestigationSummary => ({
  run_key: "account:run-1",
  issue_id: "issue-1",
  status: "received",
  has_report: false,
  created_at: 1_790_000_000_000,
  ...overrides,
});

const listInvestigations = vi.fn<WorkerIssueInbox["listInvestigations"]>();
const getSetupStatus = vi.fn<WorkerIssueInbox["getSetupStatus"]>();
const getInvestigationReport = vi.fn<WorkerIssueInbox["getInvestigationReport"]>();
const retryInvestigation = vi.fn<WorkerIssueInbox["retryInvestigation"]>();

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.head.replaceChildren();
  document.body.replaceChildren();
  listInvestigations.mockReset().mockResolvedValue([entry()]);
  getInvestigationReport.mockReset().mockResolvedValue("Read this report without interruption.");
  retryInvestigation.mockReset().mockResolvedValue(undefined);
  getSetupStatus.mockReset().mockResolvedValue({
    accountId: "a".repeat(32),
    workerName: "checkout-test",
    investigationsEnabled: false,
  });
  vi.stubGlobal("gadget", {
    listInvestigations,
    getSetupStatus,
    getInvestigationReport,
    retryInvestigation,
  });
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
async function openReport(index = 0): Promise<void> {
  const article = document.querySelectorAll<HTMLElement>("article")[index];
  article.querySelector<HTMLButtonElement>("button")!.click();
  await vi.advanceTimersByTimeAsync(0);
}

describe("Worker issue inbox", () => {
  it("presents notification-only mode and untrusted report text without executing markup", async () => {
    listInvestigations.mockResolvedValue([
      entry({
        status: "completed",
        has_report: true,
      }),
    ]);
    getInvestigationReport.mockResolvedValue('<img src="invalid" onerror="alert(1)">');
    await load();
    expect(getInvestigationReport).not.toHaveBeenCalled();
    await openReport();

    expect(document.body.textContent).toContain("Notifications only");
    expect(document.body.textContent).toContain("checkout-test");
    expect(document.body.textContent).toContain("Report ready");
    expect(document.querySelector("button")?.textContent).toBe("Refresh inbox");
    expect(document.querySelector(".report")?.textContent).toContain("<img");
    expect(document.querySelector("img")).toBeNull();
  });

  it("preserves selected report text through unchanged polls and insertion of newer entries", async () => {
    const original = entry({ status: "completed", has_report: true });
    listInvestigations.mockResolvedValue([original]);
    await load();
    await openReport();
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
    expect(window.getSelection()!.toString()).toBe("Read this report without interruption.");
    expect(getInvestigationReport).toHaveBeenCalledTimes(1);
  });

  it("keeps separate runs of the same issue distinct and updates only the changed report", async () => {
    const first = entry({ status: "completed", has_report: true });
    const second = entry({ run_key: "account:run-2", status: "queued" });
    listInvestigations.mockResolvedValue([second, first]);
    getInvestigationReport.mockImplementation(async (key) =>
      key === first.run_key ? "First occurrence" : "Second occurrence",
    );
    await load();
    await openReport(1);
    const articles = [...document.querySelectorAll("article")];
    expect(articles).toHaveLength(2);

    listInvestigations.mockResolvedValue([
      { ...second, status: "completed", has_report: true },
      first,
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    await openReport();

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

  it("pauses polling in a hidden tab and refreshes on return", async () => {
    await load();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listInvestigations).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listInvestigations).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("offers retry for a definite allocation failure", async () => {
    listInvestigations.mockResolvedValue([entry({ status: "failed" })]);
    await load();
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry investigation",
    )!;
    expect(retry.hidden).toBe(false);
    retry.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(retryInvestigation).toHaveBeenCalledWith("account:run-1");
  });
});
