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
  | "fix_unknown";

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
  investigationsEnabled: boolean;
  /** Present once fixes are enabled. */
  fixes?: FixSetup;
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
  enableInvestigations(): Promise<void>;
  /**
   * Let new runs push a fix and open a merge or pull request through the `REPOSITORY` binding,
   * which must be a contributor binding (one limited to a branch prefix). Investigations must be
   * enabled first. Earlier notifications are never replayed.
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
   * once a minute per run. Polled by the inbox page.
   */
  reconcileChanges(): Promise<void>;
}
