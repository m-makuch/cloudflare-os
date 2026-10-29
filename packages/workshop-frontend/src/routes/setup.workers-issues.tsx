import { createFileRoute, useRouterState } from "@tanstack/react-router";
import { WorkersIssueSetupPage } from "../features/workers-issues/WorkersIssueSetupPage";
import { parseWorkersIssueSetup } from "../features/workers-issues/workersIssueSetup";

const WorkersIssueSetupRoute = () => {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const request = parseWorkersIssueSetup(search);
  return request ? (
    <WorkersIssueSetupPage key={request.state} request={request} />
  ) : (
    <p role="alert" className="p-6 text-kumo-danger">
      This setup link is invalid. Start again from the Worker’s Issues page in the Cloudflare
      dashboard.
    </p>
  );
};

export const Route = createFileRoute("/setup/workers-issues")({
  component: WorkersIssueSetupRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    workers_issue_setup:
      typeof search.workers_issue_setup === "string" && search.workers_issue_setup.length <= 2048
        ? search.workers_issue_setup
        : undefined,
  }),
});
