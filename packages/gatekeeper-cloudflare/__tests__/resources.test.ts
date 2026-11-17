import { describe, expect, it } from "vitest";
import {
  ACCOUNT_OBSERVABILITY_RESOURCE,
  CLOUDFLARE_RESOURCES,
  NOTIFICATIONS_RESOURCE,
  WORKER_OBSERVABILITY_RESOURCE,
  WORKER_RELEASES_RESOURCE,
  WORKER_RELEASES_SCOPES,
  accountObservabilityUrl,
  grantedCloudflareResourcePatterns,
  parseCloudflareSubresourceId,
  parseWorkerReleasesResourceUrl,
  workerBuildSubresourceId,
  workerReleasesUrl,
  workerScriptSubresourceId,
  grantedObservabilityResourcePatterns,
  observabilityScopesForResources,
  observabilitySubresourceId,
  parseObservabilityResourceUrl,
  parseObservabilitySubresourceId,
  workerObservabilityUrl,
} from "../src/resources";
import { BILLING_SCOPES, persistentScopesForResources } from "../src/oauth";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

describe("Cloudflare observability resources", () => {
  it("round-trips account observability URLs", () => {
    const url = accountObservabilityUrl(ACCOUNT_ID);

    expect(url).toBe(`https://dash.cloudflare.com/${ACCOUNT_ID}/workers-and-pages/observability`);
    expect(parseObservabilityResourceUrl(url)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("round-trips Worker observability URLs", () => {
    const url = workerObservabilityUrl(ACCOUNT_ID, "api/production");

    expect(url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api%2Fproduction/production/observability`,
    );
    expect(parseObservabilityResourceUrl(url)).toEqual({
      accountId: ACCOUNT_ID,
      workerName: "api/production",
    });
  });

  it("accepts harmless dashboard state and a trailing slash", () => {
    expect(parseObservabilityResourceUrl(
      `${accountObservabilityUrl(ACCOUNT_ID)}/?time-window=1h#logs`,
    )).toEqual({ accountId: ACCOUNT_ID });
  });

  it("rejects lookalike dashboard URLs", () => {
    expect(() => parseObservabilityResourceUrl(
      "https://example.com/account-id/workers-and-pages/observability",
    )).toThrow("Unsupported Cloudflare observability URL");
    expect(() => parseObservabilityResourceUrl(
      "https://dash.cloudflare.com/account-id/workers/services/view/api/production/metrics",
    )).toThrow("Unsupported Cloudflare observability URL");
  });

  it("rejects malformed account IDs and URL encoding", () => {
    expect(() => accountObservabilityUrl("account-id")).toThrow("account ID");
    expect(() => parseObservabilityResourceUrl(
      "https://dash.cloudflare.com/%EA/workers-and-pages/observability",
    )).toThrow("Unsupported Cloudflare observability URL");
  });
});

describe("Cloudflare observability subresource IDs", () => {
  it("names an account by one spelling however its ID was entered", () => {
    // Requirements are deduplicated and indexed by the ID string, so two spellings of one account
    // would be two resources an observer must be granted separately.
    const id = observabilitySubresourceId(ACCOUNT_ID.toUpperCase());

    expect(id).toBe(`account/${ACCOUNT_ID}`);
    expect(parseObservabilitySubresourceId(id)).toBe(ACCOUNT_ID);
  });

  it("refuses every ID it would not have made", () => {
    // Read back from an observation, an ID is untrusted input: anything other than the canonical
    // spelling is refused rather than read as some nearby account.
    for (const id of [
      `account/${ACCOUNT_ID.toUpperCase()}`,
      `observability/account/${ACCOUNT_ID}`,
      `account/${ACCOUNT_ID}/worker/${"a".repeat(32)}`,
      `accounts/${ACCOUNT_ID}`,
      `account/account-id`,
      `%61ccount/${ACCOUNT_ID}`,
    ]) {
      expect(() => parseObservabilitySubresourceId(id), id).toThrow();
    }
  });
});

describe("Cloudflare observability OAuth scopes", () => {
  it("keeps billing-only connections free of observability access", () => {
    expect(persistentScopesForResources([])).toEqual(BILLING_SCOPES);
    expect(persistentScopesForResources()).toContain("workers-observability.read");
  });

  it("does not request observability for an explicit empty resource list", () => {
    expect(observabilityScopesForResources([])).not.toContain("workers-observability.read");
  });

  it("requests observability for either binding granularity", () => {
    expect(observabilityScopesForResources([ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern]))
      .toContain("workers-observability.read");
    expect(observabilityScopesForResources([WORKER_OBSERVABILITY_RESOURCE.urlPattern]))
      .toContain("workers-observability.read");
  });

  it("treats an omitted resource list as all supported resources", () => {
    expect(observabilityScopesForResources()).toContain("workers-observability.read");
  });

  it("rejects unknown resource patterns", () => {
    expect(() => observabilityScopesForResources(["https://example.com/*"]))
      .toThrow("Unsupported Cloudflare resource type");
  });

  it("maps the shared OAuth permission back to both resource types", () => {
    expect(grantedObservabilityResourcePatterns(["workers-observability.read"]))
      .toEqual([
        ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern,
        WORKER_OBSERVABILITY_RESOURCE.urlPattern,
      ]);
    expect(grantedObservabilityResourcePatterns([])).toEqual([]);
  });
});

describe("Cloudflare Worker releases resource", () => {
  it("is offered with the dashboard's deployments URL", () => {
    expect(CLOUDFLARE_RESOURCES).toContain(WORKER_RELEASES_RESOURCE);
    expect(WORKER_RELEASES_RESOURCE.urlPattern).toBe(
      "https://dash.cloudflare.com/:accountId/workers/services/view/:workerName/production/deployments");
  });

  it("round-trips Worker releases URLs", () => {
    const url = workerReleasesUrl(ACCOUNT_ID, "api/production");

    expect(url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api%2Fproduction/production/deployments`);
    expect(parseWorkerReleasesResourceUrl(url)).toEqual({ accountId: ACCOUNT_ID, workerName: "api/production" });
  });

  it("keeps the releases and observability URLs apart", () => {
    // A Worker observability binding must never be read as a releases binding, which can write.
    expect(() => parseWorkerReleasesResourceUrl(workerObservabilityUrl(ACCOUNT_ID, "api")))
      .toThrow("Unsupported Cloudflare Worker releases URL");
    expect(() => parseObservabilityResourceUrl(workerReleasesUrl(ACCOUNT_ID, "api")))
      .toThrow("Unsupported Cloudflare observability URL");
    expect(() => parseWorkerReleasesResourceUrl(
      `https://example.com/${ACCOUNT_ID}/workers/services/view/api/production/deployments`)).toThrow();
  });

  it("requests every releases scope only when the resource is selected", () => {
    const scopes = persistentScopesForResources([WORKER_RELEASES_RESOURCE.urlPattern]);

    expect(scopes).toEqual(expect.arrayContaining([...BILLING_SCOPES, ...WORKER_RELEASES_SCOPES]));
    expect(WORKER_RELEASES_SCOPES).toEqual([
      "workers-scripts.read", "workers-ci.read", "workers-observability.read", "workers-observability.write",
    ]);
    // An omitted list means "all resource types" but never asks for the write scope.
    expect(persistentScopesForResources()).not.toContain("workers-observability.write");
    expect(persistentScopesForResources([WORKER_OBSERVABILITY_RESOURCE.urlPattern]))
      .not.toContain("workers-observability.write");
  });

  it("requests a shared scope once", () => {
    const scopes = persistentScopesForResources([
      WORKER_OBSERVABILITY_RESOURCE.urlPattern, WORKER_RELEASES_RESOURCE.urlPattern,
      NOTIFICATIONS_RESOURCE.urlPattern,
    ]);

    expect(scopes.filter(scope => scope === "workers-observability.read")).toHaveLength(1);
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes).toContain("notifications.write");
  });

  it("counts as granted only when every releases scope was granted", () => {
    expect(grantedCloudflareResourcePatterns([...BILLING_SCOPES, ...WORKER_RELEASES_SCOPES]))
      .toContain(WORKER_RELEASES_RESOURCE.urlPattern);
    for (const missing of WORKER_RELEASES_SCOPES) {
      const granted = grantedCloudflareResourcePatterns(
        WORKER_RELEASES_SCOPES.filter(scope => scope !== missing));
      expect(granted, missing).not.toContain(WORKER_RELEASES_RESOURCE.urlPattern);
    }
    // Observability and notifications grants are unaffected.
    expect(grantedCloudflareResourcePatterns(["workers-observability.read"])).toEqual([
      ACCOUNT_OBSERVABILITY_RESOURCE.urlPattern, WORKER_OBSERVABILITY_RESOURCE.urlPattern,
    ]);
    expect(grantedCloudflareResourcePatterns(["notifications.write"])).toEqual([NOTIFICATIONS_RESOURCE.urlPattern]);
  });
});

describe("Cloudflare Worker releases subresource IDs", () => {
  const BUILD = "dddddddd-0000-4000-8000-000000000004";

  it("names a Worker's script and a build under their account", () => {
    expect(workerScriptSubresourceId(ACCOUNT_ID.toUpperCase(), "api/worker"))
      .toBe(`account/${ACCOUNT_ID}/workers-script/api%2Fworker`);
    expect(workerBuildSubresourceId(ACCOUNT_ID, BUILD)).toBe(`account/${ACCOUNT_ID}/workers-build/${BUILD}`);
    expect(() => workerBuildSubresourceId(ACCOUNT_ID, "not-a-build")).toThrow();
  });

  it("reads back every kind it makes", () => {
    expect(parseCloudflareSubresourceId(observabilitySubresourceId(ACCOUNT_ID)))
      .toEqual({ kind: "telemetry", accountId: ACCOUNT_ID });
    expect(parseCloudflareSubresourceId(workerScriptSubresourceId(ACCOUNT_ID, "api/worker")))
      .toEqual({ kind: "script", accountId: ACCOUNT_ID, workerName: "api/worker" });
    expect(parseCloudflareSubresourceId(workerBuildSubresourceId(ACCOUNT_ID, BUILD)))
      .toEqual({ kind: "build", accountId: ACCOUNT_ID, buildUuid: BUILD });
  });

  it("refuses every ID it would not have made", () => {
    for (const id of [
      `account/${ACCOUNT_ID.toUpperCase()}/workers-script/api`,
      `account/${ACCOUNT_ID}/worker/api`,
      `account/${ACCOUNT_ID}/workers-build/${BUILD.toUpperCase()}`,
      `account/${ACCOUNT_ID}/workers-build/not-a-build`,
      `account/${ACCOUNT_ID}/workers-script/api/workers-build/${BUILD}`,
      `releases/account/${ACCOUNT_ID}`,
    ]) {
      expect(() => parseCloudflareSubresourceId(id), id).toThrow();
    }
    // The observability binding's own parser is unchanged: it still accepts only the account.
    expect(() => parseObservabilitySubresourceId(workerScriptSubresourceId(ACCOUNT_ID, "api"))).toThrow();
  });
});
