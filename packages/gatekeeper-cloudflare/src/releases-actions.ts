// The one write a Worker releases binding makes: marking a Real-Time Issue of its Worker resolved,
// as a kit action. Nothing here runs until the action is approved (or auto-approved under the
// "resolve-worker-issue" rule); apply checks again that the issue is the Worker's, records the
// status it replaced, and revert restores that status.

import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { ActionApplyError, defineActions, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import { deniesAccess } from "./observability-api.js";
import type { CloudflareWorkerReleasesApi, IssueStatus } from "./releases-api.js";
import { VENDOR_ID } from "./vendor.js";

/**
 * Users' auto-approval rules are stored under this tag, so it is never renamed, and no other
 * action may share it.
 */
export const RESOLVE_WORKER_ISSUE: ActionKind = {
  tag: "resolve-worker-issue", label: "Resolve Worker issues",
};

/** Marking one Real-Time Issue of the bound Worker resolved. */
export type ResolveIssue = {
  issueId: string;
  /** The issue's title as staging read it, for the approver. */
  title: string;
  /** The issue's status as staging read it, for the approver. */
  statusAtSubmit: IssueStatus;
  /** When it was staged, which a simulated read reports as the status change. */
  stagedAt: number;
  /** Set once applied: the status the issue had just before, which a revert restores. */
  previousStatus?: IssueStatus;
  /** Set once applied, for pruning retained records. */
  appliedAt?: number;
};

/** Every action's payload, by kind. */
export type ReleasesActions = { resolveIssue: ResolveIssue };

export type ReleasesAction = TaggedAction<ReleasesActions>;

/** What apply handlers may use. */
export type ReleasesActionHost = {
  readonly workerName: string;
  /** The bound Worker's API, under the connection's current credentials. */
  api(): CloudflareWorkerReleasesApi;
};

export const releasesActions = defineActions<ReleasesActionHost, ReleasesActions>({
  resolveIssue: {
    kind: RESOLVE_WORKER_ISSUE,
    // No opt-out rule applies: it changes a status in the bound Worker's own issue list, which
    // Workers Observability reverses by itself if the error recurs, and revert restores.
    autoApprovable: true,
    delivery: "continue-with-simulation",
    describe: (payload, host) => ({
      title: sanitizeTitle(`Resolve an issue of Worker ${host.workerName}`),
      ...buildDescription("Marks a Workers Observability Real-Time Issue resolved. Workers "
        + "Observability makes it active again if the error recurs.")
        .inline("Worker", host.workerName)
        .inline("Issue", payload.issueId)
        .inline("Title", payload.title)
        .inline("Status", `${payload.statusAtSubmit} → resolved`)
        .finish(),
      implementsRevert: true,
    }),
    // Setting a status is idempotent, so a plain error leaves the action retryable.
    apply: async (payload, host) => {
      let before;
      try {
        before = await host.api().setIssueStatus(payload.issueId, "resolved");
      } catch (error) {
        // Cloudflare refused, or the issue is gone or now another Worker's: nothing was changed.
        if (deniesAccess(error)) throw new ActionApplyError(error.message);
        throw error;
      }
      return { action: { ...payload, previousStatus: before.status, appliedAt: Date.now() } };
    },
  },
}, {
  // The payload names an issue of the binding's own Worker in its own account, both fixed by the
  // binding and checked again at apply, so it means the same under any credentials the
  // connection holds later.
  fence: "none",
  // Kept for revert; CloudflareWorkerReleasesGatekeeper prunes them.
  retainApplied: true,
  vendorId: VENDOR_ID,
});
