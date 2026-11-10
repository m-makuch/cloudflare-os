// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The dashboard opens `/?workers_issue_setup=<JSON>`. TanStack Router's default search parser
// JSON-decodes that value into an object, and its stringifier quotes a JSON-looking string, so the
// request must travel through the router as the validated object: as a string it was dropped on
// Home, and quoted on the way to the setup page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseWorkersIssueSetup,
  validateWorkersIssueSetupSearch,
  workersIssueSetupSearch,
  type WorkersIssueSetupRequest,
} from "./workersIssueSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

const request: WorkersIssueSetupRequest = {
  state: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  accountId: "a".repeat(32),
  workerName: "checkout-test",
  issueId: "issue-1",
  dashboardOrigin: "https://dash.cloudflare.com",
  investigation: { workspaceId: "b".repeat(64), destinationId: "destination-1" },
  remediation: { approval: "ask", allowPublic: false, repositoryUrl: "https://github.com/acme/widgets" },
};

let received: WorkersIssueSetupRequest | undefined | "unset" = "unset";

function makeRouter(initialEntry: string) {
  const rootRoute = createRootRoute({
    component: function Root() {
      const pathname = useRouterState({ select: (s) => s.location.pathname });
      const search = useRouterState({ select: (s) => s.location.searchStr });
      const setup = workersIssueSetupSearch(search);
      if (pathname === "/" && setup.workers_issue_setup) {
        return <Navigate to="/setup/workers-issues" search={setup} replace />;
      }
      return <Outlet />;
    },
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    validateSearch: validateWorkersIssueSetupSearch,
    component: () => <p>home</p>,
  });
  const setup = createRoute({
    getParentRoute: () => rootRoute,
    path: "/setup/workers-issues",
    validateSearch: validateWorkersIssueSetupSearch,
    component: function Setup() {
      received = setup.useSearch().workers_issue_setup;
      return <p>setup</p>;
    },
  });
  return createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren([home, setup]),
  });
}

describe("routing a dashboard setup request", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    received = "unset";
  });

  async function renderAt(entry: string) {
    const router = makeRouter(entry);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await act(async () => { await router.load(); });
    return router;
  }

  it("carries the request from Home to the setup page intact, as the dashboard sends it", async () => {
    const entry = `/?${new URLSearchParams({ workers_issue_setup: JSON.stringify(request) })}`;
    const router = await renderAt(entry);
    expect(router.state.location.pathname).toBe("/setup/workers-issues");
    expect(received).toEqual(request);
    // The address the setup page sits at still parses, e.g. for a reload.
    expect(parseWorkersIssueSetup(router.state.location.searchStr)).toEqual(request);
  });

  it("drops an invalid request rather than routing it to setup", async () => {
    const bad = { ...request, dashboardOrigin: "https://evil.example" };
    const router = await renderAt(`/?${new URLSearchParams({ workers_issue_setup: JSON.stringify(bad) })}`);
    expect(router.state.location.pathname).toBe("/");
    expect(received).toBe("unset");
  });

  it("validates a decoded or raw search value with the same rules", () => {
    expect(validateWorkersIssueSetupSearch({ workers_issue_setup: request })).toEqual({ workers_issue_setup: request });
    expect(validateWorkersIssueSetupSearch({ workers_issue_setup: JSON.stringify(request) }))
      .toEqual({ workers_issue_setup: request });
    expect(validateWorkersIssueSetupSearch({ workers_issue_setup: { ...request, extra: "x".repeat(2048) } }))
      .toEqual({ workers_issue_setup: undefined });
    expect(validateWorkersIssueSetupSearch({ workers_issue_setup: [request] })).toEqual({ workers_issue_setup: undefined });
    expect(validateWorkersIssueSetupSearch({})).toEqual({ workers_issue_setup: undefined });
  });
});
