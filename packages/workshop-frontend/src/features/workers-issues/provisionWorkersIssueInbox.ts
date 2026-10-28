import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { WorkerIssueInbox } from "../../../../bundled-blueprints/blueprints/workers-issues/files/protocol";
import type { WorkersIssueSetupRequest } from "./workersIssueSetup";

export const provisionWorkersIssueInbox = async (
  api: RpcStub<AuthenticatedApi>,
  request: WorkersIssueSetupRequest,
  accountId: number,
  workspaceId: string,
  modelId: string | undefined,
  onWorkspace: (id: string) => void,
) => {
  using workspace = workspaceId
    ? await api.openWorkspace(workspaceId)
    : await api.newWorkspaceFromBlueprint("automation.workers-issues", {
        CLOUDFLARE_NOTIFICATIONS: {
          type: "gatekeeper",
          accountId,
          resourceUrl: `https://dash.cloudflare.com/${request.accountId}/notifications`,
        },
      });
  const metadata = await workspace.getMetadata();
  onWorkspace(metadata.id);
  using gadget = await workspace.getGadget(metadata.defaultGadgetId ?? 0);
  using inbox = (await gadget.connectToGadget()) as RpcStub<WorkerIssueInbox>;

  if (request.investigation) {
    const [scope, destination] = await Promise.all([
      inbox.getSetupStatus(),
      inbox.getNotificationStatus(),
    ]);
    if (
      metadata.id !== request.investigation.workspaceId ||
      scope.accountId !== request.accountId ||
      scope.workerName !== request.workerName ||
      !destination.installed ||
      destination.suspended ||
      destination.webhookId !== request.investigation.destinationId
    ) {
      throw new Error("This inbox does not match the requested Worker and destination.");
    }
    if (!scope.investigationsEnabled) {
      if (!modelId) throw new Error("Choose a language model before enabling investigations.");
      const bindings = await gadget.listBindings();
      if (!bindings.some((binding) => binding.name === "INVESTIGATOR")) {
        using telemetry = await workspace.newGatekeeper(
          accountId,
          `https://dash.cloudflare.com/${request.accountId}/workers/services/view/${encodeURIComponent(request.workerName)}/production/observability`,
        );
        if (!telemetry) throw new Error("Worker telemetry could not be connected.");
        using investigator = await workspace.newAgentSpawnerGatekeeper({
          displayName: "Worker issue investigator",
          modelId,
          env: { WORKER_OBSERVABILITY: await telemetry.getId() },
        });
        await gadget.bind("INVESTIGATOR", await investigator.getId());
      }
      // Binding changes create a new gadget facet; never enable through the old, unbound one.
      using configuredInbox = (await gadget.connectToGadget()) as RpcStub<WorkerIssueInbox>;
      await configuredInbox.enableInvestigations();
    }
    return {
      workspaceId: metadata.id,
      destinationId: destination.webhookId,
      investigationsEnabled: true,
    };
  }

  await workspace.setTitle(`${request.workerName} issue inbox`);
  await inbox.initialize({ accountId: request.accountId, workerName: request.workerName });
  const hook = (await workspace.listHooks()).find(
    (candidate) => candidate.gadgetId === (metadata.defaultGadgetId ?? 0),
  );
  if (!hook) throw new Error("The notification subscription was not registered.");
  if (!hook.enabled) await workspace.enableHook(hook.id);
  const status = await inbox.getNotificationStatus();
  if (!status.installed || !status.webhookId || status.suspended)
    throw new Error("Notification destination is not ready.");
  return {
    workspaceId: metadata.id,
    destinationId: status.webhookId,
    investigationsEnabled: false,
  };
};
