import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { WorkerIssueInbox } from "../../../../bundled-blueprints/blueprints/workers-issues/files/lib/protocol";
import type { WorkersIssueSetupRequest } from "./workersIssueSetup";
import type { WorkersIssueTelemetryScope } from "./provisionWorkersIssueInbox";

/** Read the inbox's current choices rather than substituting the user's default model. */
export const loadWorkersIssueConfiguration = async (
  api: RpcStub<AuthenticatedApi>,
  request: WorkersIssueSetupRequest,
) => {
  if (!request.investigation) return undefined;
  using workspace = await api.openWorkspace(request.investigation.workspaceId);
  const metadata = await workspace.getMetadata();
  using gadget = await workspace.getGadget(metadata.defaultGadgetId ?? 0);
  using inbox = (await gadget.connectToGadget()) as RpcStub<WorkerIssueInbox>;
  const status = await inbox.getSetupStatus();
  if (status.accountId !== request.accountId || status.workerName !== request.workerName)
    throw new Error("This inbox does not match the requested Worker.");
  const binding = (await gadget.listBindings()).find(({ name }) => name === "INVESTIGATOR");
  let modelId: string | null | undefined;
  let maxDurationMs: number | null | undefined;
  let telemetryScope: WorkersIssueTelemetryScope = "worker";
  if (binding) {
    using investigator = await workspace.getGatekeeperById(binding.target);
    const spec = await investigator.getCreationSpec();
    if (spec.type === "agentSpawner") {
      modelId = spec.config.modelId;
      maxDurationMs = spec.config.maxDurationMs ?? null;
      using telemetry = await investigator.getBinding("WORKER_OBSERVABILITY");
      const resource = await telemetry?.getCreationSpec();
      if (
        resource?.type === "gatekeeper" &&
        resource.vendorId === "cloudflare" &&
        resource.resourceUrl ===
          `https://dash.cloudflare.com/${request.accountId}/workers-and-pages/observability`
      )
        telemetryScope = "account";
    }
  }
  return {
    modelId,
    maxDurationMs,
    telemetryScope,
    investigationsEnabled: status.investigatorReady ? status.investigationsEnabled : undefined,
    autoResolve: status.autoResolve ?? true,
  };
};
