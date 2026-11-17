import type { GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";

/** The branch namespace every fix is pushed under. */
export const FIX_BRANCH_PREFIX = "cloudflare-os/";

/** A repository resolved to the gatekeeper and contributor binding URL that can propose fixes to it. */
export type ContributorRepository = {
  vendorId: string;
  vendorName: string;
  /** The contributor resource pattern, which a connection must be granted. */
  urlPattern: string;
  /** The binding URL: the repository plus its contributor scope. */
  resourceUrl: string;
  /** `owner/repo` or `group/project`, for display. */
  path: string;
};

/**
 * Finds the gatekeeper whose contributor resource (the one whose pattern takes a `branchPrefix`
 * query) serves `repositoryUrl`'s host, and builds the binding URL in that gatekeeper's canonical
 * form. Matching by origin keeps the GitLab instance a deployment configures out of this code.
 * @returns The repository, or an error message for the user.
 */
export const resolveContributorRepository = (
  vendors: GatekeeperVendorInfo[],
  repositoryUrl: string,
  allowPublic: boolean,
): ContributorRepository | { error: string } => {
  let url: URL;
  try {
    url = new URL(repositoryUrl.trim());
  } catch {
    return { error: "Enter the repository's web address, for example https://github.com/owner/repo." };
  }
  if (url.protocol !== "https:")
    return { error: "Enter the repository's https address." };
  for (const vendor of vendors) {
    if (vendor.unavailable) continue;
    for (const resource of vendor.supportedResources) {
      if (!resource.urlPattern.includes("?branchPrefix=")) continue;
      const origin = new URL(resource.urlPattern.slice(0, resource.urlPattern.indexOf("/:"))).origin;
      if (origin !== url.origin) continue;
      // GitLab separates a project path from its pages with `/-/`; GitHub repositories are two
      // segments, followed by their pages.
      const marker = url.pathname.indexOf("/-/");
      const segments = (marker === -1 ? url.pathname : url.pathname.slice(0, marker))
        .split("/")
        .filter(Boolean);
      const github = resource.urlPattern.includes("/:owner/:repo");
      const parts = github ? segments.slice(0, 2) : segments;
      if (parts.length < 2) return { error: "That address does not name a repository." };
      parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.git$/, "");
      const path = parts.join("/");
      const query = new URLSearchParams({ branchPrefix: FIX_BRANCH_PREFIX });
      if (allowPublic) query.set("allowPublic", "true");
      return {
        vendorId: vendor.id,
        vendorName: vendor.description.displayName,
        urlPattern: resource.urlPattern,
        resourceUrl: `${origin}/${path}?${query.toString()}`,
        path,
      };
    }
  }
  return {
    error: `This OS installation cannot propose changes to repositories on ${url.host}. GitHub and the GitLab instance it is configured for are supported.`,
  };
};
