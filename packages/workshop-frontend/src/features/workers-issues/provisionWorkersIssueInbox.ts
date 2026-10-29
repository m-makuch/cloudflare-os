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
    if (!modelId) throw new Error("Choose a language model before enabling investigations.");
    const previous = (await gadget.listBindings()).find(
      (binding) => binding.name === "INVESTIGATOR",
    );
    // Spawner env edges are mutable and omitted from its creation spec. A binding name cannot
    // prove its authority, so explicitly install a fresh exact-Worker spawner and selected model.
    using telemetry = await workspace.newGatekeeper(
      accountId,
      `https://dash.cloudflare.com/${request.accountId}/workers/services/view/${encodeURIComponent(request.workerName)}/production/observability`,
    );
    if (!telemetry) throw new Error("Worker telemetry could not be connected.");
    let bound = false;
    let uncertain = false;
    try {
      using investigator = await workspace.newAgentSpawnerGatekeeper({
        displayName: "Worker issue investigator",
        modelId,
        env: { WORKER_OBSERVABILITY: await telemetry.getId() },
      });
      try {
        const target = await investigator.getId();
        try {
          if (previous) await gadget.unbind("INVESTIGATOR");
          await gadget.bind("INVESTIGATOR", target);
          bound = true;
        } catch (error) {
          // A lost response may already have committed the binding. Never remove an active target.
          uncertain = true;
          const current = (await gadget.listBindings()).find(
            (binding) => binding.name === "INVESTIGATOR",
          );
          uncertain = false;
          bound = current?.target === target;
          if (!bound) {
            if (previous && !current) await gadget.bind("INVESTIGATOR", previous.target);
            throw error;
          }
        }
      } finally {
        if (!bound && !uncertain) await investigator.remove();
      }
    } finally {
      if (!bound && !uncertain) await telemetry.remove();
    }
    // Binding changes create a new gadget facet; never enable through the old, unbound one.
    using configuredInbox = (await gadget.connectToGadget()) as RpcStub<WorkerIssueInbox>;
    await configuredInbox.enableInvestigations();
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
  if (status.credentials && status.credentials !== "ready")
    throw new Error(
      status.credentials === "reconnect_required"
        ? "Reconnect Cloudflare with Notifications access to resume delivery."
        : "Cloudflare authorization could not be checked. Try again.",
    );
  if (!status.installed || !status.webhookId || status.suspended)
    throw new Error("Notification destination is not ready.");
  return {
    workspaceId: metadata.id,
    destinationId: status.webhookId,
    investigationsEnabled: false,
  };
};
