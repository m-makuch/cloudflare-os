import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type {
  FixSetup,
  InboxSetupStatus,
  InvestigationSummary,
  InvestigationStatus,
  WorkerIssueInbox,
} from "./lib/protocol.ts";

// The Workshop iframe bootstrap supplies the RPC stub before this module runs.
declare const gadget: WorkerIssueInbox;

const style = el("style", {
  text: `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: Canvas; color: CanvasText; }
body { font: 13.5px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
button { font: inherit; }
:focus-visible { outline: 2px solid Highlight; outline-offset: 3px; }
.inbox { max-width: 1000px; margin: 0 auto; padding: 28px; }
.header, .entry-header, .summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.header { align-items: flex-start; padding-bottom: 20px; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); }
h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
h2 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0; }
.scope, .metadata, .updated, .description { color: GrayText; }
.scope { margin-top: 4px; overflow-wrap: anywhere; }
.refresh { flex-shrink: 0; padding: 7px 12px; border: 1px solid ButtonBorder; border-radius: 6px; background: ButtonFace; color: ButtonText; cursor: pointer; }
.refresh:hover { background: color-mix(in srgb, ButtonFace 90%, ButtonText); }
.refresh:disabled { opacity: .6; cursor: wait; }
a.refresh { display: inline-block; text-decoration: none; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.entry .actions { margin-top: 12px; }
.mode { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 20px 0 8px; }
.badge { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 3px 9px; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 999px; font-size: 12px; font-weight: 550; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge[data-status="received"]::before { background: transparent; border: 1px solid currentColor; }
.badge[data-status="delivery_unknown"] { border-style: dashed; }
.badge[data-status="completed"], .badge[data-status="change_opened"] { font-weight: 700; }
.badge[data-status="fix_unknown"] { border-style: dashed; }
.change { display: inline-block; margin-top: 10px; color: LinkText; overflow-wrap: anywhere; }
.description { max-width: 76ch; font-size: 13px; }
.summary { margin: 24px 0 12px; flex-wrap: wrap; font-size: 12px; }
.updated { font-variant-numeric: tabular-nums; }
.notice { padding: 12px 14px; margin-bottom: 12px; border: 1px solid ButtonBorder; border-radius: 8px; }
[hidden] { display: none !important; }
.entries { display: grid; gap: 12px; }
.entry { min-width: 0; padding: 18px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 8px; }
.entry-header { align-items: flex-start; flex-wrap: wrap; gap: 8px 16px; }
.metadata { display: block; margin-top: 4px; font-size: 12px; }
.report { margin: 16px 0 0; padding-top: 14px; border-top: 1px solid color-mix(in srgb, CanvasText 12%, Canvas); font: inherit; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.report.placeholder { color: GrayText; font-size: 13px; }
.empty { padding: 40px 20px; border: 1px dashed color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 8px; text-align: center; }
.empty p { max-width: 55ch; margin: 8px auto 0; color: GrayText; }
@media (max-width: 580px) {
  .inbox { padding: 18px 14px; }
  .header { flex-wrap: wrap; }
  .entry { padding: 14px; }
  h1 { font-size: 20px; }
}
@media (pointer: coarse) { .refresh { min-height: 44px; } }
`,
});
document.head.append(style);

const scope = el("p", { class: "scope", text: "Loading Worker scope…" });
const refresh = el("button", { class: "refresh", type: "button", text: "Refresh inbox" });
const mode = el("span", { class: "badge", text: "Loading setup…" });
const modeDescription = el("span");
const setupLink = el("a", { class: "refresh", target: "_blank", rel: "noopener noreferrer", hidden: true });
const automaticToggle = el("button", { class: "refresh", type: "button", hidden: true });
const description = el("p", { class: "description" });
const summary = el("p", { role: "status", text: "Loading inbox…" });
const updated = el("time", { class: "updated" });
const error = el("p", { class: "notice", role: "alert", hidden: true });
const emptyTitle = el("h2", { text: "Loading notifications…" });
const emptyDescription = el("p");
const empty = el("div", { class: "empty" }, [emptyTitle, emptyDescription]);
const entries = el("section", { class: "entries", "aria-label": "Issue notifications" });

document.body.replaceChildren(
  el("main", { class: "inbox" }, [
    el("header", { class: "header" }, [
      el("div", {}, [el("h1", { text: "Worker issue inbox" }), scope]),
      refresh,
    ]),
    el("div", { class: "mode" }, [mode, modeDescription]),
    el("div", { class: "actions" }, [setupLink, automaticToggle]),
    description,
    el("div", { class: "summary" }, [summary, updated]),
    error,
    empty,
    entries,
  ]),
);

const STATUS_LABELS: Record<InvestigationStatus, string> = {
  received: "Notification received",
  pending: "Waiting to start",
  failed: "Could not start investigator",
  allocating: "Starting investigator",
  dispatching: "Sending to investigator",
  queued: "Investigation queued",
  delivery_unknown: "Delivery unconfirmed",
  completed: "Report ready",
  fixing: "Fix in progress",
  push_pending: "Waiting for your approval",
  change_opened: "Change proposed",
  fix_unknown: "Fix delivery unconfirmed",
};

/** What the git host calls a proposed change. */
function changeNoun(fixes: FixSetup | undefined): string {
  return fixes?.provider === "github" ? "pull request" : "merge request";
}

let fixSetup: FixSetup | undefined;
let setupStatus: InboxSetupStatus | undefined;
/** The notification destination, read once: OS setup checks it matches before binding anything. */
let destinationId: string | undefined;
let destinationRead = false;

/**
 * This inbox's workspace. The frame is an opaque-origin srcdoc document, whose base URL is the
 * Workshop page that hosts it, so relative links open the Workshop and its path names the
 * workspace. Elsewhere (a gadget-only view) no setup link is offered.
 */
const workspaceId = (() => {
  try {
    return /^\/workspace\/([a-f\d]{64})(?:\/|$)/.exec(new URL(document.baseURI).pathname)?.[1];
  } catch {
    return undefined;
  }
})();

/**
 * The OS page that binds a Worker-scoped investigator to this inbox, which needs the user's
 * consent and a model, so the inbox cannot do it itself. With a run key, it then investigates
 * that notification.
 */
function setupUrl(runKey?: string): string | undefined {
  const scope = setupStatus;
  if (!workspaceId || !destinationId || !scope?.accountId || !scope.workerName) return undefined;
  const url = new URL("/setup/workers-issues", document.baseURI);
  url.searchParams.set(
    "workers_issue_setup",
    JSON.stringify({
      state: crypto.randomUUID(),
      accountId: scope.accountId,
      workerName: scope.workerName,
      investigation: { workspaceId, destinationId },
      ...(runKey ? { runKey } : {}),
    }),
  );
  return url.href;
}

function setLink(link: HTMLAnchorElement, href: string | undefined): void {
  link.hidden = !href;
  // A fresh setup state per render would rewrite the link under the pointer; keep the first.
  if (href && !link.dataset.ready) {
    link.href = href;
    link.dataset.ready = "1";
  }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const clockFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

type EntryView = {
  element: HTMLElement;
  title: HTMLHeadingElement;
  time: HTMLTimeElement;
  badge: HTMLSpanElement;
  report: HTMLPreElement;
  readReport: HTMLButtonElement;
  retry: HTMLButtonElement;
  investigate: HTMLButtonElement;
  investigateLink: HTMLAnchorElement;
  change: HTMLAnchorElement;
  reportLoaded: boolean;
};
const views = new Map<string, EntryView>();
let loading = false;
let loaded = false;
let disposed = false;

function setText(element: HTMLElement, text: string): void {
  // Polling unchanged reports must not replace text nodes and destroy a reader's selection.
  if (element.textContent !== text) element.textContent = text;
}

function reportText(run: InvestigationSummary): string {
  if (run.has_report) return "";
  if (run.status === "failed")
    return "The investigator could not be started. Check the model and bindings, then retry.";
  if (run.status === "received") {
    return setupStatus?.investigatorReady
      ? "Notification stored without running a model. Investigate it to start a run."
      : "Notification stored without running a model. Set up AI investigations to investigate it.";
  }
  if (run.status === "delivery_unknown") {
    return "Delivery could not be confirmed. Check the workspace conversations before sending again.";
  }
  if (run.status === "fix_unknown") {
    return `Delivery could not be confirmed. Retrying first checks the repository for a ${changeNoun(fixSetup)} from ${run.fix_branch ?? "its branch"}.`;
  }
  if (run.status === "push_pending") {
    return `The fixer proposed a ${changeNoun(fixSetup)}. Approve its push and creation in the workspace; nothing reaches the repository until you do.`;
  }
  if (run.mode === "fix") return "The fixer has not submitted a report yet.";
  return "The investigator has not submitted a report yet.";
}

function renderEntries(runs: InvestigationSummary[]): void {
  const visibleKeys = new Set(runs.map((run) => run.run_key));
  for (const [key, view] of views) {
    if (!visibleKeys.has(key)) {
      view.element.remove();
      views.delete(key);
    }
  }

  runs.forEach((run, index) => {
    let view = views.get(run.run_key);
    if (!view) {
      const title = el("h2");
      const time = el("time", { class: "metadata" });
      const badge = el("span", { class: "badge" });
      const report = el("pre", { class: "report" });
      const readReport = el("button", { class: "refresh", type: "button", text: "Read report" });
      const retry = el("button", { class: "refresh", type: "button", text: "Retry investigation" });
      const investigate = el("button", { class: "refresh", type: "button", text: "Investigate" });
      const investigateLink = el("a", {
        class: "refresh",
        target: "_blank",
        rel: "noopener noreferrer",
        text: "Set up and investigate",
      });
      const change = el("a", { class: "change", target: "_blank", rel: "noopener noreferrer" });
      const element = el("article", { class: "entry" }, [
        el("div", { class: "entry-header" }, [el("div", {}, [title, time]), badge]),
        change,
        report,
        el("div", { class: "actions" }, [readReport, retry, investigate, investigateLink]),
      ]);
      const created = {
        element,
        title,
        time,
        badge,
        report,
        readReport,
        retry,
        investigate,
        investigateLink,
        change,
        reportLoaded: false,
      };
      readReport.addEventListener("click", async () => {
        readReport.disabled = true;
        try {
          if (!created.reportLoaded) {
            setText(
              report,
              (await gadget.getInvestigationReport(run.run_key)) ?? "Report is unavailable.",
            );
            created.reportLoaded = true;
            report.hidden = false;
          } else {
            report.hidden = !report.hidden;
          }
          readReport.textContent = report.hidden ? "Read report" : "Hide report";
        } catch {
          setText(error, "Could not load the report. Try opening it again.");
          error.hidden = false;
        } finally {
          readReport.disabled = false;
        }
      });
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          await gadget.retryInvestigation(run.run_key);
          await render();
        } catch {
          setText(
            error,
            "Could not retry this investigation. Check its current status and try again.",
          );
          error.hidden = false;
        } finally {
          retry.disabled = false;
        }
      });
      investigate.addEventListener("click", async () => {
        investigate.disabled = true;
        try {
          await gadget.investigateNotification(run.run_key);
          await render();
        } catch {
          setText(error, "Could not start this investigation. Check its current status and try again.");
          error.hidden = false;
        } finally {
          investigate.disabled = false;
        }
      });
      view = created;
      views.set(run.run_key, view);
    }
    setText(view.title, run.issue_id);
    setText(view.time, dateFormat.format(run.created_at));
    view.time.dateTime = new Date(run.created_at).toISOString();
    setText(view.badge, STATUS_LABELS[run.status] ?? "Unknown status");
    view.badge.dataset.status = run.status;
    if (!view.reportLoaded) {
      setText(view.report, reportText(run));
      view.report.hidden = run.has_report;
    }
    view.report.classList.toggle("placeholder", !run.has_report);
    view.readReport.hidden = !run.has_report;
    view.retry.hidden = run.status !== "failed" && run.status !== "fix_unknown";
    setText(view.retry, run.mode === "fix" ? "Retry fix" : "Retry investigation");
    const stored = run.status === "received";
    view.investigate.hidden = !stored || !setupStatus?.investigatorReady;
    setText(view.investigate, fixSetup ? "Investigate and propose a fix" : "Investigate");
    setLink(view.investigateLink, stored && !setupStatus?.investigatorReady ? setupUrl(run.run_key) : undefined);
    // Only an https link the server validated is shown; it opens on the git host.
    const url = run.change_url;
    view.change.hidden = !url;
    if (url && view.change.href !== url) view.change.href = url;
    const state = run.change_state && run.change_state !== "opened" ? ` (${run.change_state})` : "";
    setText(view.change, url ? `View ${changeNoun(fixSetup)} ${run.change_id ? `#${run.change_id}` : ""}${state}` : "");

    // Insert new entries in order without detaching the existing report nodes.
    if (entries.children[index] !== view.element) {
      entries.insertBefore(view.element, entries.children[index] ?? null);
    }
  });
}

async function render(): Promise<void> {
  if (loading || disposed || document.hidden) return;
  loading = true;
  refresh.disabled = true;
  try {
    // Pending requests are read from the git host at most once a minute per run, server-side.
    await gadget.reconcileChanges().catch(() => undefined);
    const [runs, setup] = await Promise.all([gadget.listInvestigations(), gadget.getSetupStatus()]);
    if (!destinationRead) {
      // A failed read is retried on the next poll; an answer is kept for the page's life.
      await gadget.getNotificationStatus().then(
        (status) => {
          destinationRead = true;
          destinationId = status.installed && !status.suspended ? status.webhookId : undefined;
        },
        () => undefined,
      );
    }
    if (disposed) return;
    fixSetup = setup.fixes;
    setupStatus = setup;
    setText(
      scope,
      setup.workerName
        ? [setup.workerName, setup.accountId].filter(Boolean).join(" · ")
        : "This inbox has not been connected to a Worker yet.",
    );
    const ready = setup.investigatorReady;
    const automatic = setup.investigationsEnabled && ready;
    const fixes = ready ? setup.fixes : undefined;
    setText(
      mode,
      !ready
        ? "Notifications only"
        : `${fixes ? "AI fixes" : "AI investigations"} ${automatic ? "on" : "on request"}`,
    );
    const run = fixes ? `propose a fix as a ${changeNoun(fixes)} in ${fixes.repository}` : "start an investigation";
    setText(
      modeDescription,
      !ready
        ? "Notifications are stored without running a model."
        : automatic
          ? `New issue notifications ${fixes ? "can " : ""}${run}.`
          : `Notifications are stored. Investigate any of them to ${run}.`,
    );
    setLink(setupLink, setupUrl());
    setText(setupLink, ready ? "Change AI setup" : "Set up AI investigations");
    automaticToggle.hidden = !ready;
    setText(automaticToggle, automatic ? "Stop automatic investigations" : "Investigate new notifications automatically");
    setText(
      description,
      fixes
        ? `The fixer can push only to branches starting with "${fixes.branchPrefix}" and open ${changeNoun(fixes)}s into the default branch. It cannot merge or deploy: you review and merge, and your CI deploys. A workspace editor can change its bindings.`
        : "AI setup provisions read-only telemetry for this Worker. A workspace editor can change the investigator's bindings. Repository access, project tests, code changes, and deployments require separate capabilities.",
    );
    setText(
      summary,
      runs.length
        ? `Showing ${runs.length} recent notification${runs.length === 1 ? "" : "s"} (up to 100).`
        : "No notifications received yet.",
    );
    renderEntries(runs);
    empty.hidden = runs.length > 0;
    setText(emptyTitle, "Waiting for an issue notification");
    setText(
      emptyDescription,
      "Save your automation in the Cloudflare dashboard with this inbox as its notification destination. New issue notifications will appear here.",
    );
    error.hidden = true;
    const now = new Date();
    setText(updated, `Updated ${clockFormat.format(now)}`);
    updated.dateTime = now.toISOString();
    loaded = true;
  } catch {
    if (disposed) return;
    setText(
      error,
      loaded
        ? "Could not refresh the inbox. Showing the last loaded notifications. Refresh to try again."
        : "Could not load the inbox. Refresh to try again.",
    );
    error.hidden = false;
    if (!loaded) {
      empty.hidden = true;
      setText(scope, "Worker scope unavailable");
      setText(mode, "Setup unavailable");
      setText(summary, "Inbox unavailable.");
    }
  } finally {
    loading = false;
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", () => {
  void render();
});
automaticToggle.addEventListener("click", async () => {
  automaticToggle.disabled = true;
  try {
    // Only an inbox with a bound investigator shows this; binding one is OS setup's.
    if (setupStatus?.investigationsEnabled) await gadget.disableInvestigations();
    else await gadget.enableInvestigations();
    await render();
  } catch {
    setText(error, "Could not change automatic investigations. Refresh and try again.");
    error.hidden = false;
  } finally {
    automaticToggle.disabled = false;
  }
});
const timer = setInterval(() => {
  void render();
}, 5000);
const resume = () => {
  if (!document.hidden) void render();
};
document.addEventListener("visibilitychange", resume);
window.addEventListener(
  "pagehide",
  () => {
    disposed = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", resume);
  },
  { once: true },
);
void render();
