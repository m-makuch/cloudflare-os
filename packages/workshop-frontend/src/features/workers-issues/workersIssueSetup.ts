export const WORKERS_ISSUE_SETUP_PARAM = "workers_issue_setup";

export type WorkersIssueSetupRequest = {
  state: string;
  accountId: string;
  workerName: string;
  issueId?: string;
  dashboardOrigin: string;
  investigation?: { workspaceId: string; destinationId: string };
};

const isDashboardOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      ((url.protocol === "https:" &&
        ["dash.cloudflare.com", "dash.staging.cloudflare.com"].includes(url.hostname)) ||
        (import.meta.env.DEV &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          ["http:", "https:"].includes(url.protocol)))
    );
  } catch {
    return false;
  }
};

export const parseWorkersIssueSetup = (search: string): WorkersIssueSetupRequest | null => {
  const values = new URLSearchParams(search).getAll(WORKERS_ISSUE_SETUP_PARAM);
  if (values.length !== 1 || values[0].length > 2048) return null;
  try {
    const request: unknown = JSON.parse(values[0]);
    if (typeof request !== "object" || request === null) return null;
    const { state, accountId, workerName, issueId, dashboardOrigin, investigation } =
      request as Record<string, unknown>;
    if (
      typeof state !== "string" ||
      !/^[a-f\d-]{36}$/i.test(state) ||
      typeof accountId !== "string" ||
      !/^[a-f\d]{32}$/.test(accountId) ||
      typeof workerName !== "string" ||
      !/^[a-z\d_-]{1,63}$/i.test(workerName) ||
      (issueId !== undefined &&
        (typeof issueId !== "string" || !/^[a-z\d-]{1,128}$/i.test(issueId))) ||
      typeof dashboardOrigin !== "string" ||
      !isDashboardOrigin(dashboardOrigin)
    )
      return null;
    if (
      investigation !== undefined &&
      (typeof investigation !== "object" ||
        investigation === null ||
        !("workspaceId" in investigation) ||
        typeof investigation.workspaceId !== "string" ||
        !/^[a-f\d]{64}$/.test(investigation.workspaceId) ||
        !("destinationId" in investigation) ||
        typeof investigation.destinationId !== "string" ||
        !/^[a-z\d-]{1,128}$/i.test(investigation.destinationId))
    )
      return null;
    return {
      state,
      accountId,
      workerName,
      issueId,
      dashboardOrigin,
      ...(investigation
        ? { investigation: investigation as WorkersIssueSetupRequest["investigation"] }
        : {}),
    };
  } catch {
    return null;
  }
};

/** Carry only a validated setup request through signup and sign-in navigation. */
export const workersIssueSetupSearch = (search: string): { workers_issue_setup?: string } => {
  const request = parseWorkersIssueSetup(search);
  return request ? { workers_issue_setup: JSON.stringify(request) } : {};
};

export const respondToWorkersIssueSetup = (
  request: WorkersIssueSetupRequest,
  result: {
    destinationId: string;
    workspaceId: string;
    investigationsEnabled?: boolean;
    investigateCurrent?: boolean;
  },
): (() => void) => {
  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.origin !== request.dashboardOrigin ||
      !event.source ||
      typeof event.data !== "object" ||
      event.data === null ||
      !("type" in event.data) ||
      event.data.type !== "cloudflare-os:workers-issues:status" ||
      !("state" in event.data) ||
      event.data.state !== request.state
    )
      return;
    event.source.postMessage(
      {
        type: "cloudflare-os:workers-issues:ready",
        state: request.state,
        accountId: request.accountId,
        ...result,
      },
      { targetOrigin: request.dashboardOrigin },
    );
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
};
