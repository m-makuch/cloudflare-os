import { createFileRoute } from "@tanstack/react-router";
import { WorkersIssueSetupPage } from "../features/workers-issues/WorkersIssueSetupPage";
import { validateWorkersIssueSetupSearch } from "../features/workers-issues/workersIssueSetup";

const WorkersIssueSetupRoute = () => {
  // Validated by validateSearch, which the router hands the request already JSON-decoded.
  const request = Route.useSearch().workers_issue_setup;
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
  validateSearch: validateWorkersIssueSetupSearch,
});
