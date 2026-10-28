/** The inbox setup surface; notification delivery stays on its persistent hook. */
export interface WorkerIssueInbox {
  initialize(scope: { accountId: string; workerName: string }): Promise<void>;
  getNotificationStatus(): Promise<{ installed: boolean; suspended: boolean; webhookId?: string }>;
  getSetupStatus(): Promise<{ accountId?: string; workerName?: string; investigationsEnabled: boolean }>;
  enableInvestigations(): Promise<void>;
  listInvestigations(): Promise<Array<{ issue_id: string; status: string; report: string | null; created_at: number }>>;
}
