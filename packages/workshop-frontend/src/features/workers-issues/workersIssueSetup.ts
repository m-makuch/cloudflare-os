export const WORKERS_ISSUE_SETUP_PARAM = "workers_issue_setup";

/**
 * What the dashboard asks for when the user opted into fixes: whether each push and merge or pull
 * request waits for approval, whether public repositories are allowed, and the repository Workers
 * Builds deploys from, to prefill. The OS page shows each choice again before applying it.
 */
export type WorkersIssueRemediationRequest = {
  approval: "ask" | "automatic";
  allowPublic: boolean;
  repositoryUrl?: string;
};

export type WorkersIssueSetupRequest = {
  state: string;
  accountId: string;
  workerName: string;
  issueId?: string;
  dashboardOrigin: string;
  investigation?: { workspaceId: string; destinationId: string };
  /** Only with `investigation`: fixes build on investigations. */
  remediation?: WorkersIssueRemediationRequest;
};

const parseRemediation = (value: unknown): WorkersIssueRemediationRequest | null => {
  if (typeof value !== "object" || value === null) return null;
  const { approval, allowPublic, repositoryUrl } = value as Record<string, unknown>;
  if ((approval !== "ask" && approval !== "automatic") || typeof allowPublic !== "boolean")
    return null;
  if (repositoryUrl === undefined) return { approval, allowPublic };
  if (typeof repositoryUrl !== "string" || repositoryUrl.length > 300) return null;
  try {
    if (new URL(repositoryUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { approval, allowPublic, repositoryUrl };
};

/**
 * Exact HTTPS origins a test deployment additionally trusts as the dashboard, e.g. a developer's
 * local dashboard driving a deployed instance. Build-time and unset by default, so a release
 * trusts only the Cloudflare dashboards.
 */
export const extraDashboardOrigins = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map(origin => origin.trim())
    .filter(origin => {
      try {
        const url = new URL(origin);
        return url.protocol === "https:" && url.origin === origin;
      } catch {
        return false;
      }
    });

const EXTRA_DASHBOARD_ORIGINS = extraDashboardOrigins(
  import.meta.env.VITE_WORKERS_ISSUE_EXTRA_DASHBOARD_ORIGINS,
);

export const isDashboardOrigin = (value: string, extra = EXTRA_DASHBOARD_ORIGINS): boolean => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      ((url.protocol === "https:" &&
        ["dash.cloudflare.com", "dash.staging.cloudflare.com"].includes(url.hostname)) ||
        extra.includes(value) ||
        (import.meta.env.DEV &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          ["http:", "https:"].includes(url.protocol)))
    );
  } catch {
    return false;
  }
};

/** Above this a request is refused: it is carried in a URL, and every real one is far smaller. */
const MAX_SETUP_REQUEST_LENGTH = 2048;

/** The setup request from the raw query string, e.g. `window.location.search`. */
export const parseWorkersIssueSetup = (search: string): WorkersIssueSetupRequest | null => {
  const values = new URLSearchParams(search).getAll(WORKERS_ISSUE_SETUP_PARAM);
  return values.length === 1 ? parseWorkersIssueSetupValue(values[0]) : null;
};

/**
 * The setup request from one search value: the JSON text, or, from TanStack Router, the object its
 * default search parser already decoded that text into. Either is held to the same rules.
 */
export const parseWorkersIssueSetupValue = (value: unknown): WorkersIssueSetupRequest | null => {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof text !== "string" || text.length > MAX_SETUP_REQUEST_LENGTH) return null;
    const request: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
    const { state, accountId, workerName, issueId, dashboardOrigin, investigation, remediation } =
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
    const parsedRemediation = remediation === undefined ? undefined : parseRemediation(remediation);
    if (parsedRemediation === null || (parsedRemediation && !investigation)) return null;
    return {
      state,
      accountId,
      workerName,
      issueId,
      dashboardOrigin,
      ...(investigation
        ? { investigation: investigation as WorkersIssueSetupRequest["investigation"] }
        : {}),
      ...(parsedRemediation ? { remediation: parsedRemediation } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * Carry only a validated setup request through signup, sign-in and Home. It is handed to the router
 * as the object: the router serializes it as JSON, where a JSON string would be quoted.
 */
export const workersIssueSetupSearch = (
  search: string,
): { workers_issue_setup?: WorkersIssueSetupRequest } => {
  const request = parseWorkersIssueSetup(search);
  return request ? { workers_issue_setup: request } : {};
};

/** `validateSearch` for the routes a setup request passes through: Home and the setup page. */
export const validateWorkersIssueSetupSearch = (
  search: Record<string, unknown>,
): { workers_issue_setup?: WorkersIssueSetupRequest } => ({
  workers_issue_setup: parseWorkersIssueSetupValue(search[WORKERS_ISSUE_SETUP_PARAM]) ?? undefined,
});

export const respondToWorkersIssueSetup = (
  request: WorkersIssueSetupRequest,
  result: {
    destinationId: string;
    workspaceId: string;
    investigationsEnabled?: boolean;
    investigateCurrent?: boolean;
    fixesEnabled?: boolean;
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
