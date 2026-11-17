import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const OBSERVABILITY_SCOPE = "workers-observability.read";
const DASHBOARD_ORIGIN = "https://dash.cloudflare.com";
const ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/i;
// How assertCloudflareAccountId spells an account ID, the only spelling a subresource ID may use.
const CANONICAL_ACCOUNT_ID_PATTERN = /^[a-f\d]{32}$/;
const ACCOUNT_FRAGMENT = "account";

export const ACCOUNT_OBSERVABILITY_RESOURCE: SupportedResource = {
  id: "account-observability",
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/workers-and-pages/observability`,
  title: "Cloudflare account observability",
  description: "Query logs, metrics, invocations, and traces across an account's Workers.",
  grantable: true,
};

export const WORKER_OBSERVABILITY_RESOURCE: SupportedResource = {
  id: "worker-observability",
  urlPattern:
    `${DASHBOARD_ORIGIN}/:accountId/workers/services/view/:workerName/production/observability`,
  title: "Cloudflare Worker observability",
  description: "Query logs, metrics, invocations, and traces for one Worker.",
  grantable: true,
};

export const OBSERVABILITY_RESOURCES = [
  ACCOUNT_OBSERVABILITY_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
];

/**
 * One Worker's releases: its deployments (with each version's annotations and Workers Builds
 * commit), the invocations a version served, and its Real-Time Issues, which a binding may mark
 * resolved. Kept apart from WORKER_OBSERVABILITY_RESOURCE, which is read-only, so that a binding to
 * that one can never resolve an issue.
 */
export const WORKER_RELEASES_RESOURCE: SupportedResource = {
  id: "worker-releases",
  urlPattern:
    `${DASHBOARD_ORIGIN}/:accountId/workers/services/view/:workerName/production/deployments`,
  title: "Cloudflare Worker releases",
  description: "Read one Worker's deployments and Real-Time Issues, and mark its issues resolved.",
  grantable: true,
};

/**
 * Every scope a Worker releases binding needs: deployments and versions, Workers Builds commits,
 * telemetry and issue reads, and the issue status write. The resource counts as granted only when
 * all of them are (see grantedCloudflareResourcePatterns), so a connection holding some of them is
 * asked for the rest rather than handed a binding that 403s.
 */
export const WORKER_RELEASES_SCOPES = [
  "workers-scripts.read",
  "workers-ci.read",
  OBSERVABILITY_SCOPE,
  "workers-observability.write",
];

const RESOURCE_PATTERNS = new Set(OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern));

/** Validate and normalize a Cloudflare account ID at an external input boundary. */
export function assertCloudflareAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("Invalid Cloudflare account ID.");
  return accountId.toLowerCase();
}

export function accountObservabilityUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers-and-pages/observability`;
}

/**
 * The subresource ID every read reports, through an account or a Worker binding alike: the account
 * whose telemetry it queried, `account/<accountId>`.
 */
export function observabilitySubresourceId(accountId: string): string {
  return formatSubresourceId({
    fragments: [{ name: ACCOUNT_FRAGMENT, id: assertCloudflareAccountId(accountId) }],
  });
}

/**
 * The account ID an ID from observabilitySubresourceId names. Throws for any other ID, another
 * spelling of the same account's included.
 */
export function parseObservabilitySubresourceId(id: string): string {
  const { namespace, fragments: [account, ...rest] } = parseSubresourceId(id);
  if (namespace === undefined && rest.length === 0 && account?.name === ACCOUNT_FRAGMENT &&
      CANONICAL_ACCOUNT_ID_PATTERN.test(account.id)) {
    return account.id;
  }
  throw new Error("Not a Cloudflare Workers Observability subresource.");
}

export function workerObservabilityUrl(accountId: string, workerName: string): string {
  return workerDashboardUrl(accountId, workerName, "observability");
}

/** The dashboard URL a Worker releases binding is granted by. */
export function workerReleasesUrl(accountId: string, workerName: string): string {
  return workerDashboardUrl(accountId, workerName, "deployments");
}

function workerDashboardUrl(accountId: string, workerName: string, page: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/workers/services/view/` +
    `${encodeURIComponent(workerName)}/production/${page}`;
}

/**
 * A dashboard URL's account and, for a Worker page, Worker and page name; null for anything else.
 * Throws for a URL that cannot be decoded or names an invalid account.
 */
function parseDashboardUrl(url: string):
    { accountId: string; workerName?: undefined; page: string } |
    { accountId: string; workerName: string; page: string } | null {
  const parsed = new URL(url);
  if (parsed.origin !== DASHBOARD_ORIGIN) return null;
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const accountId = assertCloudflareAccountId(segments[0] ?? "");
  if (segments.length === 3 && segments[1] === "workers-and-pages") {
    return { accountId, page: segments[2]! };
  }
  if (segments.length === 7 && segments[1] === "workers" && segments[2] === "services" &&
      segments[3] === "view" && segments[4] && segments[5] === "production") {
    return { accountId, workerName: segments[4], page: segments[6]! };
  }
  return null;
}

export function parseObservabilityResourceUrl(url: string): {
  accountId: string;
  workerName?: string;
} {
  try {
    const parsed = parseDashboardUrl(url);
    if (parsed?.page === "observability") {
      return parsed.workerName === undefined
        ? { accountId: parsed.accountId }
        : { accountId: parsed.accountId, workerName: parsed.workerName };
    }
  } catch {
    // Normalize URL, percent-decoding, and account-ID failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare observability URL: ${url}`);
}

/** The account and Worker a WORKER_RELEASES_RESOURCE URL names. */
export function parseWorkerReleasesResourceUrl(url: string): {
  accountId: string;
  workerName: string;
} {
  try {
    const parsed = parseDashboardUrl(url);
    if (parsed?.workerName !== undefined && parsed.page === "deployments") {
      return { accountId: parsed.accountId, workerName: parsed.workerName };
    }
  } catch {
    // Normalize URL, percent-decoding, and account-ID failures to the public resource error.
  }
  throw new Error(`Unsupported Cloudflare Worker releases URL: ${url}`);
}

export function observabilityScopesForResources(resourceUrlPatterns?: string[]): string[] {
  if (resourceUrlPatterns?.some(pattern => !RESOURCE_PATTERNS.has(pattern))) {
    throw new Error("Unsupported Cloudflare resource type.");
  }
  return resourceUrlPatterns === undefined || resourceUrlPatterns.length > 0
    ? [OBSERVABILITY_SCOPE]
    : [];
}

export function grantedObservabilityResourcePatterns(scopes: string[]): string[] {
  return scopes.includes(OBSERVABILITY_SCOPE)
    ? OBSERVABILITY_RESOURCES.map(resource => resource.urlPattern)
    : [];
}

/** Account-scoped Cloudflare Notifications resource. */
export const NOTIFICATIONS_RESOURCE: SupportedResource = {
  id: "notifications",
  urlPattern: `${DASHBOARD_ORIGIN}/:accountId/notifications`,
  title: "Cloudflare Notifications",
  description: "Receive Cloudflare notifications through a managed webhook.",
  grantable: true,
};

export const NOTIFICATIONS_SCOPE = "notifications.write";
export const CLOUDFLARE_RESOURCES = [
  ...OBSERVABILITY_RESOURCES, WORKER_RELEASES_RESOURCE, NOTIFICATIONS_RESOURCE,
];

export function accountNotificationsUrl(accountId: string): string {
  return `${DASHBOARD_ORIGIN}/${assertCloudflareAccountId(accountId)}/notifications`;
}

export function parseNotificationsResourceUrl(url: string): { accountId: string } {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const accountId = assertCloudflareAccountId(segments[0] ?? "");
    if (parsed.origin === DASHBOARD_ORIGIN && segments.length === 2 &&
        segments[1] === "notifications") return { accountId };
  } catch {
    // Normalize URL parsing and validation failures.
  }
  throw new Error(`Unsupported Cloudflare Notifications URL: ${url}`);
}

export function grantedCloudflareResourcePatterns(scopes: string[]): string[] {
  return [
    ...grantedObservabilityResourcePatterns(scopes),
    // Fails closed: every scope or none, so a partial grant re-prompts in ensureResources.
    ...(WORKER_RELEASES_SCOPES.every(scope => scopes.includes(scope))
      ? [WORKER_RELEASES_RESOURCE.urlPattern] : []),
    ...(scopes.includes(NOTIFICATIONS_SCOPE) ? [NOTIFICATIONS_RESOURCE.urlPattern] : []),
  ];
}

const WORKER_SCRIPT_FRAGMENT = "workers-script";
const WORKER_BUILD_FRAGMENT = "workers-build";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What a Worker releases read reports for a Worker's deployments and versions:
 * `account/<accountId>/workers-script/<workerName>`, checked by reading the Worker's deployments
 * with the observer's own credentials.
 */
export function workerScriptSubresourceId(accountId: string, workerName: string): string {
  return formatSubresourceId({ fragments: [
    { name: ACCOUNT_FRAGMENT, id: assertCloudflareAccountId(accountId) },
    { name: WORKER_SCRIPT_FRAGMENT, id: workerName },
  ] });
}

/**
 * What a Worker releases read reports for each Workers Builds build whose commit or branch it
 * returned: `account/<accountId>/workers-build/<buildUuid>`, checked by reading that build with
 * the observer's own credentials. `buildUuid` must be a lowercase UUID.
 */
export function workerBuildSubresourceId(accountId: string, buildUuid: string): string {
  if (!UUID_PATTERN.test(buildUuid)) throw new Error("Invalid Workers Builds build ID.");
  return formatSubresourceId({ fragments: [
    { name: ACCOUNT_FRAGMENT, id: assertCloudflareAccountId(accountId) },
    { name: WORKER_BUILD_FRAGMENT, id: buildUuid },
  ] });
}

/** A Cloudflare subresource, as parseCloudflareSubresourceId reads it back. */
export type CloudflareSubresource =
  /** An account's telemetry and Real-Time Issues (observabilitySubresourceId). */
  | { kind: "telemetry"; accountId: string }
  /** A Worker's deployments and versions (workerScriptSubresourceId). */
  | { kind: "script"; accountId: string; workerName: string }
  /** One Workers Builds build (workerBuildSubresourceId). */
  | { kind: "build"; accountId: string; buildUuid: string };

/**
 * Reads back any ID observabilitySubresourceId, workerScriptSubresourceId or
 * workerBuildSubresourceId made. Throws for any other ID, another spelling of one included.
 */
export function parseCloudflareSubresourceId(id: string): CloudflareSubresource {
  const { namespace, fragments: [account, child, ...rest] } = parseSubresourceId(id);
  if (namespace === undefined && rest.length === 0 && account?.name === ACCOUNT_FRAGMENT &&
      CANONICAL_ACCOUNT_ID_PATTERN.test(account.id)) {
    const accountId = account.id;
    if (child === undefined) return { kind: "telemetry", accountId };
    if (child.name === WORKER_SCRIPT_FRAGMENT) {
      return { kind: "script", accountId, workerName: child.id };
    }
    if (child.name === WORKER_BUILD_FRAGMENT && UUID_PATTERN.test(child.id)) {
      return { kind: "build", accountId, buildUuid: child.id };
    }
  }
  throw new Error("Not a Cloudflare subresource.");
}
