/** Notification text is evidence, never authority to widen the configured Worker scope. */
export function issueIdentity(notification, scope) {
  const data = notification?.data;
  if (notification?.accountId !== scope.accountId ||
      notification.alertType !== 'workers_observability_real_time_issue' ||
      !data || typeof data !== 'object' || data.state_event !== 'ALERT_STATE_EVENT_START' ||
      !Array.isArray(data.issue?.services) || !data.issue.services.some(service =>
        service.name === scope.workerName && service.type === 'SERVICE_TYPE_WORKER')) return null;
  const correlation = data.state_correlation_id;
  const issueId = data.issue.id;
  if (typeof correlation !== 'string' || !/^[a-z\d-]{1,128}$/i.test(correlation) ||
      typeof issueId !== 'string' || !/^[a-z\d-]{1,128}$/i.test(issueId) ||
      (notification.correlationId !== undefined && notification.correlationId !== correlation)) return null;
  return { key: `${scope.accountId}:${correlation}`, issueId };
}
