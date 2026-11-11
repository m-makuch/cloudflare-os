import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvestigationSummary, WorkerIssueInbox } from "../files/lib/protocol.ts";

const entry = (overrides: Partial<InvestigationSummary> = {}): InvestigationSummary => ({
  run_key: "account:run-1",
  issue_id: "issue-1",
  status: "received",
  has_report: false,
  created_at: 1_790_000_000_000,
  mode: null,
  fix_branch: null,
  change_id: null,
  change_url: null,
  change_state: null,
  merge_commit: null,
  release_deployment: null,
  release_version: null,
  released_at: null,
  resolved_at: null,
  release_note: null,
  ...overrides,
});

const listInvestigations = vi.fn<WorkerIssueInbox["listInvestigations"]>();
const getSetupStatus = vi.fn<WorkerIssueInbox["getSetupStatus"]>();
const getInvestigationReport = vi.fn<WorkerIssueInbox["getInvestigationReport"]>();
const retryInvestigation = vi.fn<WorkerIssueInbox["retryInvestigation"]>();
const reconcileChanges = vi.fn<WorkerIssueInbox["reconcileChanges"]>();
const getNotificationStatus = vi.fn<WorkerIssueInbox["getNotificationStatus"]>();
const investigateNotification = vi.fn<WorkerIssueInbox["investigateNotification"]>();
const enableInvestigations = vi.fn<WorkerIssueInbox["enableInvestigations"]>();
const disableInvestigations = vi.fn<WorkerIssueInbox["disableInvestigations"]>();
const workspaceId = "b".repeat(64);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  document.head.replaceChildren();
  document.body.replaceChildren();
  listInvestigations.mockReset().mockResolvedValue([entry()]);
  getInvestigationReport.mockReset().mockResolvedValue("Read this report without interruption.");
  retryInvestigation.mockReset().mockResolvedValue(undefined);
  reconcileChanges.mockReset().mockResolvedValue(undefined);
  getNotificationStatus
    .mockReset()
    .mockResolvedValue({ installed: true, suspended: false, webhookId: "destination-1" });
  investigateNotification.mockReset().mockResolvedValue(undefined);
  enableInvestigations.mockReset().mockResolvedValue(undefined);
  disableInvestigations.mockReset().mockResolvedValue(undefined);
  getSetupStatus.mockReset().mockResolvedValue({
    accountId: "a".repeat(32),
    workerName: "checkout-test",
    investigationsEnabled: false,
    investigatorReady: false,
  releasesReady: false,
  backgroundChecks: false,
  });
  // The frame's base URL is the Workshop page hosting it.
  history.replaceState(null, "", `/workspace/${workspaceId}`);
  vi.stubGlobal("gadget", {
    listInvestigations,
    getSetupStatus,
    getInvestigationReport,
    retryInvestigation,
    reconcileChanges,
    getNotificationStatus,
    investigateNotification,
    enableInvestigations,
    disableInvestigations,
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

const buttonNamed = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);
const linkNamed = (text: string, root: ParentNode = document) =>
  [...root.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) => candidate.textContent === text);
const setupRequest = (anchor: HTMLAnchorElement) => {
  const url = new URL(anchor.href);
  expect(url.origin + url.pathname).toBe(`${location.origin}/setup/workers-issues`);
  expect(anchor.target).toBe("_blank");
  return JSON.parse(url.searchParams.get("workers_issue_setup")!);
};

const release = (article: HTMLElement) => article.querySelector<HTMLElement>(".release")!;

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
    getSetupStatus.mockResolvedValue({
      workerName: "checkout-test",
      investigationsEnabled: true,
      investigatorReady: true,
    releasesReady: false,
    backgroundChecks: false,
    });
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

  it("presents fix mode, a pending request, and a link to an opened one on the git host", async () => {
    getSetupStatus.mockResolvedValue({
      accountId: "a".repeat(32),
      workerName: "checkout-test",
      investigationsEnabled: true,
      investigatorReady: true,
      releasesReady: false,
      backgroundChecks: false,
      fixes: { provider: "gitlab", repository: "acme/checkout", branchPrefix: "cloudflare-os/" },
    });
    const url = "https://gitlab.example.com/acme/checkout/-/merge_requests/7";
    listInvestigations.mockResolvedValue([
      entry({ run_key: "a:2", status: "change_opened", mode: "fix", change_id: "7", change_url: url, change_state: "opened" }),
      entry({ run_key: "a:1", status: "push_pending", mode: "fix", change_id: "~1" }),
      entry({ run_key: "a:0", status: "fix_unknown", mode: "fix", fix_branch: "cloudflare-os/fix/issue-1-abc" }),
    ]);
    await load();
    expect(reconcileChanges).toHaveBeenCalled();
    expect(document.body.textContent).toContain("AI fixes on");
    expect(document.body.textContent).toContain('branches starting with "cloudflare-os/"');
    expect(document.body.textContent).toContain("cannot merge or deploy");
    const [opened, pending, unknown] = document.querySelectorAll<HTMLElement>("article");
    const link = opened!.querySelector<HTMLAnchorElement>("a.change")!;
    expect(link.href).toBe(url);
    expect(link.rel).toContain("noopener");
    expect(link.textContent).toContain("merge request #7");
    expect(pending!.textContent).toContain("Waiting for your approval");
    expect(pending!.querySelector<HTMLAnchorElement>("a.change")!.hidden).toBe(true);
    expect(unknown!.textContent).toContain("checks the repository");
    const retry = [...unknown!.querySelectorAll("button")].find(button => button.textContent === "Retry fix")!;
    expect(retry.hidden).toBe(false);
  });

  it("explains where a merged fix is on its way to production", async () => {
    getSetupStatus.mockResolvedValue({
      accountId: "a".repeat(32),
      workerName: "checkout-test",
      investigationsEnabled: true,
      investigatorReady: true,
      releasesReady: true,
      backgroundChecks: true,
      fixes: { provider: "github", repository: "acme/checkout", branchPrefix: "cloudflare-os/" },
    });
    const url = "https://github.com/acme/checkout/pull/9";
    const fix = { mode: "fix" as const, change_id: "9", change_url: url, change_state: "merged" as const, has_report: true };
    listInvestigations.mockResolvedValue([
      entry({ run_key: "a:4", status: "resolved", ...fix, released_at: 1_790_000_000_000 }),
      entry({ run_key: "a:3", status: "recurring", ...fix }),
      entry({ run_key: "a:2", status: "released", ...fix }),
      entry({ run_key: "a:1", status: "change_merged", ...fix, release_note: "unmapped" }),
      entry({ run_key: "a:0", status: "regressed", ...fix }),
    ]);
    await load();
    const [resolved, recurring, released, merged, regressed] = document.querySelectorAll<HTMLElement>("article");
    expect(resolved!.textContent).toContain("Resolved");
    expect(release(resolved!).textContent).toContain("resolved in Workers Observability");
    expect(recurring!.querySelector(".badge")!.getAttribute("data-tone")).toBe("danger");
    expect(release(recurring!).textContent).toContain("did not resolve it");
    expect(release(released!).textContent).toContain("60 minutes of traffic");
    expect(release(merged!).textContent).toContain("--tag");
    expect(release(regressed!).textContent).toContain("reopened");
    // The report is still offered alongside.
    expect(resolved!.querySelector<HTMLElement>(".report")!.hidden).toBe(true);
    expect([...resolved!.querySelectorAll("button")].some((button) => button.textContent === "Read report")).toBe(true);
  });

  it("keeps showing the inbox when the repository cannot be read", async () => {
    reconcileChanges.mockRejectedValue(new Error("unavailable"));
    await load();
    expect(document.querySelectorAll("article")).toHaveLength(1);
    expect(document.querySelector<HTMLElement>("[role=alert]")!.hidden).toBe(true);
  });

  it("links to OS setup for this inbox, and for one stored notification, before an investigator is bound", async () => {
    await load();
    expect(document.body.textContent).toContain("Notifications only");
    const setup = linkNamed("Set up AI investigations")!;
    expect(setup.hidden).toBe(false);
    expect(setupRequest(setup)).toEqual({
      state: expect.stringMatching(/^[a-f\d-]{36}$/),
      accountId: "a".repeat(32),
      workerName: "checkout-test",
      investigation: { workspaceId, destinationId: "destination-1" },
    });
    const article = document.querySelector("article")!;
    expect(buttonNamed("Investigate", article)!.hidden).toBe(true);
    expect(setupRequest(linkNamed("Set up and investigate", article)!)).toMatchObject({
      runKey: "account:run-1",
    });
    expect(buttonNamed("Investigate new notifications automatically")!.hidden).toBe(true);
  });

  it("asks for fixes again when changing the setup of an inbox that proposes them", async () => {
    getSetupStatus.mockResolvedValue({
      accountId: "a".repeat(32),
      workerName: "checkout-test",
      investigationsEnabled: true,
      investigatorReady: true,
      releasesReady: true,
      backgroundChecks: true,
      fixes: { provider: "github", repository: "acme/checkout", branchPrefix: "cloudflare-os/" },
    });
    await load();
    expect(setupRequest(linkNamed("Change AI setup")!).remediation).toEqual({
      allowPublic: false,
      repositoryUrl: "https://github.com/acme/checkout",
    });
  });

  it("offers no setup link outside a workspace page", async () => {
    history.replaceState(null, "", "/gadget/1");
    await load();
    expect(linkNamed("Set up AI investigations")!.hidden).toBe(true);
    expect(linkNamed("Set up and investigate")!.hidden).toBe(true);
  });

  it("investigates a stored notification on request, and turns automatic runs on and off", async () => {
    getSetupStatus.mockResolvedValue({
      accountId: "a".repeat(32),
      workerName: "checkout-test",
      investigationsEnabled: false,
      investigatorReady: true,
    releasesReady: false,
    backgroundChecks: false,
    });
    await load();
    expect(document.body.textContent).toContain("AI investigations on request");
    expect(linkNamed("Change AI setup")!.hidden).toBe(false);
    const article = document.querySelector("article")!;
    expect(linkNamed("Set up and investigate", article)!.hidden).toBe(true);
    buttonNamed("Investigate", article)!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(investigateNotification).toHaveBeenCalledWith("account:run-1");

    buttonNamed("Investigate new notifications automatically")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(enableInvestigations).toHaveBeenCalledTimes(1);
    getSetupStatus.mockResolvedValue({
      accountId: "a".repeat(32),
      workerName: "checkout-test",
      investigationsEnabled: true,
      investigatorReady: true,
    releasesReady: false,
    backgroundChecks: false,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.body.textContent).toContain("AI investigations on");
    buttonNamed("Stop automatic investigations")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(disableInvestigations).toHaveBeenCalledTimes(1);
  });
});
