import type { WorkerScope } from "./protocol.ts";

/** Narrow untrusted webhook objects before reading their fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Notification text is evidence, never authority to widen the configured Worker scope. */
export function issueIdentity(notification: unknown, scope: WorkerScope): {
  key: string;
  issueId: string;
} | null {
  if (!isRecord(notification)) return null;
  const data = notification.data;
  if (
    notification.accountId !== scope.accountId ||
    notification.alertType !== "workers_observability_real_time_issue" ||
    !isRecord(data) ||
    data.state_event !== "ALERT_STATE_EVENT_START" ||
    !isRecord(data.issue) ||
    !Array.isArray(data.issue.services) ||
    !data.issue.services.some(service =>
      isRecord(service) && service.name === scope.workerName && service.type === "SERVICE_TYPE_WORKER")
  ) return null;

  const correlation = data.state_correlation_id;
  const issueId = data.issue.id;
  if (
    typeof correlation !== "string" || !/^[a-z\d-]{1,128}$/i.test(correlation) ||
    typeof issueId !== "string" || !/^[a-z\d-]{1,128}$/i.test(issueId) ||
    (notification.correlationId !== undefined && notification.correlationId !== correlation)
  ) return null;

  return { key: `${scope.accountId}:${correlation}`, issueId };
}
