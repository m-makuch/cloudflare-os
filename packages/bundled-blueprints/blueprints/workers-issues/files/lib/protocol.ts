/** The Cloudflare account and Worker this inbox receives notifications for. */
export interface WorkerScope {
  accountId: string;
  workerName: string;
}

/**
 * Durable progress of one logical issue notification. A fix run moves through `fixing` once its
 * fixer has the task, then `push_pending` once it reports a merge or pull request that is still
 * waiting for approval, and `change_opened` once the request exists on the git host. An ambiguous
 * fix dispatch is `fix_unknown`: the repository is checked for its branch before any retry.
 *
 * After the request is merged (`change_merged`) the inbox watches the Worker's deployments: once
 * every version serving traffic contains the merge, the fix is `released`, and it is verified on
 * that traffic. It becomes `resolved` -- in Workers Observability too -- after a verification
 * window with traffic and no new occurrence, or `recurring` if the issue occurs after the release.
 * A resolved issue that fires again is `regressed`.
 */
export type InvestigationStatus =
  | "received"
  | "pending"
  | "failed"
  | "allocating"
  | "dispatching"
  | "queued"
  | "delivery_unknown"
  | "completed"
  | "fixing"
  | "push_pending"
  | "change_opened"
  | "fix_unknown"
  | "change_merged"
  | "released"
  | "recurring"
  | "resolved"
  | "regressed";

/**
 * Why a merged or released fix is still waiting: the live deployment names no commit to compare
 * (`unmapped`), the release has not had enough traffic to verify (`no_traffic`), or the live
 * deployment no longer contains it (`rolled_back`).
 */
export type ReleaseNote = "unmapped" | "no_traffic" | "rolled_back";

/** Whether a run only investigates, or may also push a fix and open a merge or pull request. */
export type RunMode = "investigate" | "fix";

/** The state of the merge or pull request a fix run opened, as last read from the git host. */
export type ChangeState = "opened" | "merged" | "closed";

/** One inbox entry; the run key distinguishes repeated occurrences of the same issue. */
export type Investigation = {
  run_key: string;
  issue_id: string;
  status: InvestigationStatus;
  report: string | null;
  created_at: number;
  mode: RunMode | null;
  /** The branch a fix run pushes to, fixed before dispatch so a retry reuses it. */
  fix_branch: string | null;
  /** The merge or pull request number, or a provisional id like `~1` while it awaits approval. */
  change_id: string | null;
  /** Its web page, once it exists on the git host. */
  change_url: string | null;
  change_state: ChangeState | null;
  /** The commit the merge put on the default branch. */
  merge_commit: string | null;
  /** The live deployment first found to contain the merge, and its versions (comma-separated). */
  release_deployment: string | null;
  release_version: string | null;
  /** When that deployment was created, in ms since the epoch: verification counts from here. */
  released_at: number | null;
  resolved_at: number | null;
  release_note: ReleaseNote | null;
};

/** The git host behind the inbox's repository binding. */
export type RepositoryProvider = "gitlab" | "github";

/** What the inbox records when fixes are enabled, read from its repository binding. */
export interface FixSetup {
  provider: RepositoryProvider;
  /** The repository's path (`group/project`) or full name (`owner/repo`). */
  repository: string;
  /** Every fix branch starts with this, e.g. `cloudflare-os/`. */
  branchPrefix: string;
}

/** Lightweight polling result; full report text is fetched only when opened. */
export type InvestigationSummary = Omit<Investigation, "report"> & { has_report: boolean };

/** Scope is absent until the inbox has been initialized. */
export interface InboxSetupStatus extends Partial<WorkerScope> {
  /** Whether every new notification starts a run on its own. */
  investigationsEnabled: boolean;
  /**
   * Whether a Worker-scoped investigator is bound, so a stored notification can be investigated
   * on request. Binding one is the OS setup page's: it needs the user's consent and a model.
   */
  investigatorReady: boolean;
  /** Present once fixes are enabled. */
  fixes?: FixSetup;
  /** Whether a Worker releases binding is bound, so a merged fix is followed to its release. */
  releasesReady: boolean;
  /** Whether a schedule checks the inbox while no one has it open. */
  backgroundChecks: boolean;
}

/** The inbox RPC contract shared by its browser, server, and OS setup frontend. */
export interface WorkerIssueInbox {
  initialize(scope: WorkerScope): Promise<void>;
  getNotificationStatus(): Promise<{
    installed: boolean;
    suspended: boolean;
    webhookId?: string;
    credentials?: "ready" | "reconnect_required" | "unavailable";
    pendingDeliveries?: number;
    retryingDeliveries?: number;
  }>;
  getSetupStatus(): Promise<InboxSetupStatus>;
  /** Start a run for every new notification. Earlier notifications are never replayed. */
  enableInvestigations(): Promise<void>;
  /** New notifications are only stored again; each can still be investigated on request. */
  disableInvestigations(): Promise<void>;
  /**
   * Start a run for one stored notification (status `received`) with the bound investigator: a
   * fix run when fixes are enabled. Each notification is investigated at most once this way.
   */
  investigateNotification(runKey: string): Promise<void>;
  /**
   * Let runs push a fix and open a merge or pull request through the `REPOSITORY` binding,
   * which must be a contributor binding (one limited to a branch prefix). An investigator must be
   * bound first. Earlier runs are never replayed.
   */
  enableFixes(): Promise<FixSetup>;
  /** New runs only investigate again; runs already dispatched are unaffected. */
  disableFixes(): Promise<void>;
  listInvestigations(): Promise<InvestigationSummary[]>;
  getInvestigationReport(runKey: string): Promise<string | null>;
  /**
   * Retry a definite failure before dispatch, or an unconfirmed fix dispatch once the repository
   * shows no merge or pull request from its branch. Never an ambiguous investigation delivery.
   */
  retryInvestigation(runKey: string): Promise<void>;
  /**
   * Read the git host for fix runs whose merge or pull request is pending or unreported, at most
   * once a minute per run, and the Worker's releases for merged fixes. Polled by the inbox page
   * and, once background checks are on, by a schedule.
   */
  reconcileChanges(): Promise<void>;
  /**
   * Register a schedule, through the `SCHEDULER` binding, that runs the inbox's checks while no
   * one has it open. Idempotent. Its hook starts disabled: OS setup enables it.
   */
  enableBackgroundChecks(): Promise<void>;
}
