import { describe, expect, it } from "vitest";
import type { GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";
import { resolveContributorRepository } from "./contributorRepository";

const vendor = (id: string, displayName: string, patterns: string[], unavailable = false) =>
  ({
    id,
    description: { displayName, url: "https://example.test" },
    supportedResources: patterns.map((urlPattern) => ({ urlPattern, title: urlPattern, description: "" })),
    ...(unavailable ? { unavailable } : {}),
  }) as GatekeeperVendorInfo;

const vendors = [
  vendor("github", "GitHub", [
    "https://github.com/:owner/:repo\\?branchPrefix=*",
    "https://github.com/:owner/:repo",
  ]),
  vendor("gitlab", "GitLab", [
    "https://gitlab.example.com/:project+\\?branchPrefix=*",
    "https://gitlab.example.com/:project+",
  ]),
];

describe("resolveContributorRepository", () => {
  it("builds the GitHub contributor binding URL from a repository or any page in it", () => {
    for (const url of [
      "https://github.com/acme/checkout",
      "https://github.com/acme/checkout.git",
      "https://github.com/acme/checkout/tree/main/src",
    ]) {
      expect(resolveContributorRepository(vendors, url, false), url).toEqual({
        vendorId: "github",
        vendorName: "GitHub",
        urlPattern: "https://github.com/:owner/:repo\\?branchPrefix=*",
        resourceUrl: "https://github.com/acme/checkout?branchPrefix=cloudflare-os%2F",
        path: "acme/checkout",
      });
    }
  });

  it("builds a GitLab one for the configured instance, nested groups included, and carries allowPublic", () => {
    expect(
      resolveContributorRepository(vendors, "https://gitlab.example.com/group/sub/checkout/-/tree/main", true),
    ).toMatchObject({
      vendorId: "gitlab",
      resourceUrl: "https://gitlab.example.com/group/sub/checkout?branchPrefix=cloudflare-os%2F&allowPublic=true",
      path: "group/sub/checkout",
    });
  });

  it("explains what it cannot use", () => {
    expect(resolveContributorRepository(vendors, "not a url", false)).toHaveProperty("error");
    expect(resolveContributorRepository(vendors, "http://github.com/acme/checkout", false)).toHaveProperty("error");
    expect(resolveContributorRepository(vendors, "https://github.com/acme", false)).toEqual({
      error: "That address does not name a repository.",
    });
    expect(resolveContributorRepository(vendors, "https://bitbucket.org/acme/checkout", false)).toEqual({
      error: expect.stringContaining("bitbucket.org"),
    });
    // A gatekeeper the installation cannot reach is not offered.
    const down = [vendor("github", "GitHub", ["https://github.com/:owner/:repo\\?branchPrefix=*"], true)];
    expect(resolveContributorRepository(down, "https://github.com/acme/checkout", false)).toHaveProperty("error");
  });
});
