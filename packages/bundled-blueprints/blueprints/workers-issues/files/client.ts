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

// The look follows Cloudflare's Kumo design system, which the dashboard and the Workshop use. The
// sandboxed frame cannot load Kumo, so its tokens (theme-kumo.css) and the Button, Badge and
// Banner variants are restated here; light-dark() follows the viewer's colour scheme.
const style = el("style", {
  text: `
:root {
  color-scheme: light dark;
  --base: light-dark(#fff, oklch(17% 0 0));
  --elevated: light-dark(oklch(98% 0 0), oklch(12% 0 0));
  --tint: light-dark(oklch(97% 0 0), oklch(26.9% 0 0));
  --fill: light-dark(oklch(92.2% 0 0), oklch(26.9% 0 0));
  --line: light-dark(oklch(14.5% 0 0 / .1), oklch(32% 0 0));
  --hairline: light-dark(oklch(93.5% 0 0), oklch(26.9% 0 0));
  --text: light-dark(oklch(21% .006 285.885), oklch(97% 0 0));
  --strong: light-dark(oklch(14.5% 0 0), oklch(98.5% 0 0));
  --subtle: light-dark(oklch(55.6% 0 0), oklch(70.8% 0 0));
  --link: light-dark(oklch(42.4% .199 265.638), oklch(70.7% .165 254.624));
  --focus: light-dark(oklch(15% 0 0), oklch(93.5% 0 0));
  --brand: light-dark(oklch(.5772 .2324 260), color-mix(in oklch, oklch(.5772 .2324 260), black 10%));
  --neutral-text: light-dark(oklch(26.9% 0 0), oklch(92.2% 0 0));
  --info: light-dark(oklch(42.4% .199 265.638), oklch(70.7% .165 254.624));
  --info-tint: light-dark(oklch(93.2% .032 255.6 / .45), oklch(38% .145 265.5 / .22));
  --success: light-dark(oklch(43.2% .095 166.913), oklch(90.5% .093 164.15));
  --success-tint: light-dark(oklch(96.2% .043 156.7 / .57), oklch(39.3% .096 152.3 / .2));
  --warning: light-dark(oklch(59.7% .144 57.5), oklch(75% .183 55.934));
  --warning-tint: light-dark(oklch(93.1% .107 94.6 / .2), oklch(35.3% .079 65 / .37));
  --danger: light-dark(oklch(50.5% .213 27.518), oklch(70.4% .191 22.216));
  --danger-tint: light-dark(oklch(93.6% .032 17.7 / .42), oklch(42.9% .176 28.7 / .17));
  --shadow-xs: 0 1px 2px 0 rgb(0 0 0 / .05);
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--base); color: var(--text); }
body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
button { font: inherit; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.inbox { max-width: 1000px; margin: 0 auto; padding: 28px; }
.header, .entry-header, .summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.header { align-items: flex-start; }
h1 { margin: 0; font-size: 20px; font-weight: 600; color: var(--strong); }
h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--strong); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; overflow-wrap: anywhere; }
p { margin: 0; }
.scope, .metadata, .updated, .description { color: var(--subtle); }
.scope { margin-top: 2px; font-size: 13px; overflow-wrap: anywhere; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; height: 36px; padding: 0 12px 2px;
  border: 0; border-radius: 8px; font-size: 14px; font-weight: 500; line-height: 1; text-decoration: none; white-space: nowrap; cursor: pointer;
  background: var(--base); color: var(--text); box-shadow: 0 0 0 1px var(--line), var(--shadow-xs);
}
.btn:hover:not(:disabled) { background: var(--tint); }
.btn:disabled { cursor: not-allowed; opacity: .7; }
.btn.primary {
  --ring: color-mix(in oklch, var(--brand), black 10%); --top: color-mix(in oklch, var(--brand), white 30%);
  color: #fff; background: linear-gradient(to bottom, color-mix(in oklch, var(--brand), white 15%), var(--brand));
  box-shadow: 0 0 0 1px var(--ring), inset 0 1px 0 0 var(--top), var(--shadow-xs);
}
.btn.primary:hover:not(:disabled) { background: linear-gradient(to bottom, var(--top), var(--brand)); }
.btn.primary:disabled { opacity: .5; }
.btn.ghost { background: transparent; box-shadow: none; }
.btn.ghost:hover:not(:disabled) { background: var(--tint); }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.setup { margin-top: 20px; padding: 16px; border-radius: 8px; background: var(--elevated); box-shadow: 0 0 0 1px var(--hairline); }
.setup .actions { margin-top: 14px; }
.setup .description { margin-top: 10px; }
.mode { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.mode-description { color: var(--text); }
.badge { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap; background: var(--fill); color: var(--neutral-text); }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge[data-tone="info"] { background: var(--info-tint); color: var(--info); }
.badge[data-tone="success"] { background: var(--success-tint); color: var(--success); }
.badge[data-tone="warning"] { background: var(--warning-tint); color: var(--warning); }
.badge[data-tone="danger"] { background: var(--danger-tint); color: var(--danger); }
.change { display: inline-block; margin-top: 10px; color: var(--link); font-weight: 500; overflow-wrap: anywhere; }
.description { max-width: 80ch; font-size: 13px; }
.summary { margin: 24px 0 12px; flex-wrap: wrap; font-size: 13px; color: var(--subtle); }
.updated { font-variant-numeric: tabular-nums; }
.notice { padding: 12px 14px; margin-top: 16px; border-radius: 8px; background: var(--danger-tint); color: var(--danger); box-shadow: 0 0 0 1px color-mix(in oklch, var(--danger), transparent 75%); }
[hidden] { display: none !important; }
.entries { display: grid; gap: 12px; }
.entry { min-width: 0; padding: 16px; border-radius: 8px; background: var(--base); box-shadow: 0 0 0 1px var(--line), var(--shadow-xs); }
.entry-header { align-items: flex-start; flex-wrap: wrap; gap: 8px 16px; }
.metadata { display: block; margin-top: 2px; font-size: 13px; }
.entry .actions { margin-top: 14px; }
.actions:not(:has(> :not([hidden]))) { display: none; }
.report { margin: 14px 0 0; padding-top: 14px; border-top: 1px solid var(--hairline); font: inherit; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.report.placeholder { color: var(--subtle); font-size: 13px; }
.empty { padding: 40px 20px; border-radius: 8px; background: var(--elevated); box-shadow: 0 0 0 1px var(--hairline); text-align: center; }
.empty h2 { font-family: inherit; }
.empty p { max-width: 55ch; margin: 6px auto 0; color: var(--subtle); font-size: 13px; }
@media (max-width: 580px) {
  .inbox { padding: 18px 14px; }
  .header { flex-wrap: wrap; }
  .entry, .setup { padding: 14px; }
}
@media (pointer: coarse) { .btn { min-height: 44px; } }
`,
});
document.head.append(style);

const scope = el("p", { class: "scope", text: "Loading Worker scope…" });
const refresh = el("button", { class: "btn", type: "button", text: "Refresh inbox" });
const mode = el("span", { class: "badge", text: "Loading setup…" });
const modeDescription = el("span", { class: "mode-description" });
const setupLink = el("a", { class: "btn", target: "_blank", rel: "noopener noreferrer", hidden: true });
const automaticToggle = el("button", { class: "btn", type: "button", hidden: true });
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
    el("section", { class: "setup", "aria-label": "AI setup" }, [
      el("div", { class: "mode" }, [mode, modeDescription]),
      description,
      el("div", { class: "actions" }, [setupLink, automaticToggle]),
    ]),
    error,
    el("div", { class: "summary" }, [summary, updated]),
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

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** The Kumo badge variant for each status: work in progress, done, waiting on you, failed. */
const STATUS_TONES: Record<InvestigationStatus, Tone> = {
  received: "neutral",
  pending: "info",
  failed: "danger",
  allocating: "info",
  dispatching: "info",
  queued: "info",
  delivery_unknown: "warning",
  completed: "success",
  fixing: "info",
  push_pending: "warning",
  change_opened: "success",
  fix_unknown: "warning",
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
      const readReport = el("button", { class: "btn", type: "button", text: "Read report" });
      const retry = el("button", { class: "btn", type: "button", text: "Retry investigation" });
      const investigate = el("button", { class: "btn primary", type: "button", text: "Investigate" });
      const investigateLink = el("a", {
        class: "btn primary",
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
    view.badge.dataset.tone = STATUS_TONES[run.status] ?? "neutral";
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
    mode.dataset.tone = !ready ? "neutral" : automatic ? "success" : "info";
    setLink(setupLink, setupUrl());
    setText(setupLink, ready ? "Change AI setup" : "Set up AI investigations");
    // Setting up is the inbox's one next step until an investigator is bound; then it is secondary.
    setupLink.classList.toggle("primary", !ready);
    setupLink.classList.toggle("ghost", ready);
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
      mode.dataset.tone = "danger";
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
