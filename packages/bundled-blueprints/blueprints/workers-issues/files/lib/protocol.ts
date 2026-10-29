/** The Cloudflare account and Worker this inbox receives notifications for. */
export interface WorkerScope {
  accountId: string;
  workerName: string;
}

/** Durable progress of one logical issue notification. */
export type InvestigationStatus =
  | "received"
  | "allocating"
  | "dispatching"
  | "queued"
  | "delivery_unknown"
  | "completed";

/** One inbox entry; the run key distinguishes repeated occurrences of the same issue. */
export type Investigation = {
  run_key: string;
  issue_id: string;
  status: InvestigationStatus;
  report: string | null;
  created_at: number;
};

/** Scope is absent until the inbox has been initialized. */
export interface InboxSetupStatus extends Partial<WorkerScope> {
  investigationsEnabled: boolean;
}

/** The inbox RPC contract shared by its browser, server, and OS setup frontend. */
export interface WorkerIssueInbox {
  initialize(scope: WorkerScope): Promise<void>;
  getNotificationStatus(): Promise<{
    installed: boolean;
    suspended: boolean;
    webhookId?: string;
  }>;
  getSetupStatus(): Promise<InboxSetupStatus>;
  enableInvestigations(): Promise<void>;
  listInvestigations(): Promise<Investigation[]>;
}
