import { el } from "@gadgets/bundled-blueprints/libraries/ui/client";
import type {
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
.mode { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 20px 0 8px; }
.badge { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 3px 9px; border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas); border-radius: 999px; font-size: 12px; font-weight: 550; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge[data-status="received"]::before { background: transparent; border: 1px solid currentColor; }
.badge[data-status="delivery_unknown"] { border-style: dashed; }
.badge[data-status="completed"] { font-weight: 700; }
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
    el("p", {
      class: "description",
      text: "Dashboard setup provisions read-only telemetry for this Worker. A workspace editor can change the investigator's bindings. Repository access, project tests, code changes, and deployments require separate capabilities.",
    }),
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
};

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
    return "Notification stored without running a model. Enabling AI investigations does not replay earlier notifications.";
  }
  if (run.status === "delivery_unknown") {
    return "Delivery could not be confirmed. Check the workspace conversations before sending again.";
  }
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
      const element = el("article", { class: "entry" }, [
        el("div", { class: "entry-header" }, [el("div", {}, [title, time]), badge]),
        report,
        readReport,
        retry,
      ]);
      const created = {
        element,
        title,
        time,
        badge,
        report,
        readReport,
        retry,
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
    view.retry.hidden = run.status !== "failed";

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
    const [runs, setup] = await Promise.all([gadget.listInvestigations(), gadget.getSetupStatus()]);
    if (disposed) return;
    setText(
      scope,
      setup.workerName
        ? [setup.workerName, setup.accountId].filter(Boolean).join(" · ")
        : "This inbox has not been connected to a Worker yet.",
    );
    setText(mode, setup.investigationsEnabled ? "AI investigations on" : "Notifications only");
    setText(
      modeDescription,
      setup.investigationsEnabled
        ? "New issue notifications can start an investigation."
        : "Notifications are stored without running a model.",
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
