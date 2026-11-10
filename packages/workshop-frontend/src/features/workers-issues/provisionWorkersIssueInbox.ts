import type { RpcStub } from "capnweb";
import type {
  AuthenticatedApi,
  GadgetClient,
  GatekeeperClient,
  Overseer,
} from "@gadgets/workshop-shared/api";
import type { WorkerIssueInbox } from "../../../../bundled-blueprints/blueprints/workers-issues/files/protocol";
import type { WorkersIssueSetupRequest } from "./workersIssueSetup";

/**
 * What fixes need: the repository's contributor binding. Enabling fixes is the user's approval of
 * the fixer's pushes and requests, so they are auto-approved.
 */
export type WorkersIssueFixSetup = {
  /** The connected git account to create the binding with. */
  accountId: number;
  /** The contributor binding URL (see `resolveContributorRepository`). */
  resourceUrl: string;
  allowPublic: boolean;
};

/** A binding change whose outcome could not be read back: neither target may be removed. */
class UncertainBindingError extends Error {
  constructor(readonly cause: unknown) {
    super("Binding outcome unknown.");
  }
}

/**
 * Points the gadget's binding `name` at `target`, restoring the previous target if the change
 * fails. A lost response may already have committed it, so a failure is read back first.
 * @throws The failure, or `UncertainBindingError` when the binding cannot even be read.
 */
const replaceBinding = async (
  gadget: RpcStub<GadgetClient>,
  name: string,
  target: Awaited<ReturnType<GatekeeperClient<never>["getId"]>>,
): Promise<void> => {
  const previous = (await gadget.listBindings()).find((binding) => binding.name === name);
  try {
    if (previous) await gadget.unbind(name);
    await gadget.bind(name, target);
  } catch (error) {
    let current;
    try {
      current = (await gadget.listBindings()).find((binding) => binding.name === name);
    } catch {
      throw new UncertainBindingError(error);
    }
    if (current?.target === target) return;
    if (previous && !current) await gadget.bind(name, previous.target);
    throw error;
  }
};

const RESOLVE_WORKER_ISSUE = "resolve-worker-issue";

/**
 * Binds the owner's Scheduled Tasks into the inbox and turns on its periodic checks, opting the
 * owner into Scheduled Tasks if the deployment only offers it.
 * @throws When Scheduled Tasks are unavailable or the schedule cannot be registered.
 */
const enableBackgroundChecks = async (
  api: RpcStub<AuthenticatedApi>,
  workspace: RpcStub<Overseer>,
  gadget: RpcStub<GadgetClient>,
  gadgetId: number,
): Promise<void> => {
  let scheduler = await workspace.getAmbientGatekeeper("scheduler");
  if (!scheduler) {
    await api.provisionAmbientAccount("scheduler");
    scheduler = await workspace.getAmbientGatekeeper("scheduler");
  }
  if (!scheduler) throw new Error("Scheduled Tasks are not available.");
  using schedulerClient = scheduler;
  const schedulerId = await schedulerClient.getId();
  await replaceBinding(gadget, "SCHEDULER", schedulerId);
  // The binding restarted the gadget; register through the new facet.
  using inbox = (await gadget.connectToGadget()) as RpcStub<WorkerIssueInbox>;
  await inbox.enableBackgroundChecks();
  // A schedule's hook delivers nothing until enabled.
  for (const hook of await workspace.listHooks()) {
    if (hook.gatekeeperId === schedulerId && hook.gadgetId === gadgetId && !hook.enabled)
      await workspace.enableHook(hook.id);
  }
};

export const provisionWorkersIssueInbox = async (
  api: RpcStub<AuthenticatedApi>,
  request: WorkersIssueSetupRequest,
  accountId: number,
  workspaceId: string,
  modelId: string | undefined,
  onWorkspace: (id: string) => void,
  fix?: WorkersIssueFixSetup,
  /** Whether every new notification starts a run, or only those the user picks in the inbox. */
  automatic = true,
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
    if (fix && metadata.containsRestrictedData) {
      // A workspace that has read restricted data refuses every push, so a fix could never land.
      throw new Error(
        "This inbox's workspace has read restricted data, so it cannot push fixes. Create a new inbox for this Worker to enable fixes.",
      );
    }
    // Spawner env edges are mutable and omitted from its creation spec. A binding name cannot
    // prove its authority, so explicitly install fresh exact-scope gatekeepers and a new spawner.
    // Until the spawner is bound, nothing references them, and a failure removes them.
    const created: Array<{ remove(): Promise<void> }> = [];
    let committed = false;
    let uncertain = false;
    let repositoryId: Awaited<ReturnType<GatekeeperClient<never>["getId"]>> | undefined;
    let releasesId: Awaited<ReturnType<GatekeeperClient<never>["getId"]>> | undefined;
    try {
      using telemetry = await workspace.newGatekeeper(
        accountId,
        `https://dash.cloudflare.com/${request.accountId}/workers/services/view/${encodeURIComponent(request.workerName)}/production/observability`,
      );
      if (!telemetry) throw new Error("Worker telemetry could not be connected.");
      created.push(telemetry);
      using repository = fix ? await workspace.newGatekeeper(fix.accountId, fix.resourceUrl) : null;
      using releases = fix
        ? await workspace.newGatekeeper(
            accountId,
            `https://dash.cloudflare.com/${request.accountId}/workers/services/view/${encodeURIComponent(request.workerName)}/production/deployments`,
          )
        : null;
      if (fix) {
        if (!repository) throw new Error("The repository could not be connected.");
        created.push(repository);
        repositoryId = await repository.getId();
        if (!releases) throw new Error("This Worker's deployments could not be connected.");
        created.push(releases);
        releasesId = await releases.getId();
        // Checked here to fail early with a clear message; the gatekeeper checks again, fresh,
        // before every push and request.
        using session = (await repository.openSession()) as RpcStub<{
          getMetadata(): Promise<{ visibility?: string }>;
        }>;
        if ((await session.getMetadata()).visibility === "public" && !fix.allowPublic)
          throw new Error(
            "This repository is public. Allow public repositories to propose fixes to it.",
          );
      }
      using investigator = await workspace.newAgentSpawnerGatekeeper({
        displayName: fix ? "Worker issue fixer" : "Worker issue investigator",
        modelId,
        env: {
          WORKER_OBSERVABILITY: await telemetry.getId(),
          ...(repositoryId === undefined ? {} : { REPOSITORY: repositoryId }),
        },
      });
      created.push(investigator);
      await replaceBinding(gadget, "INVESTIGATOR", await investigator.getId());
      committed = true;
      if (repositoryId !== undefined) await replaceBinding(gadget, "REPOSITORY", repositoryId);
      if (releasesId !== undefined) await replaceBinding(gadget, "WORKER_RELEASES", releasesId);
    } catch (error) {
      uncertain = error instanceof UncertainBindingError;
      throw uncertain ? (error as UncertainBindingError).cause : error;
    } finally {
      if (!committed && !uncertain) for (const target of created.toReversed()) await target.remove();
    }
    // Binding changes create a new gadget facet; never enable through the old, unbound one.
    using configuredInbox = (await gadget.connectToGadget()) as RpcStub<WorkerIssueInbox>;
    // Called only when needed: an inbox created before on-request runs has no way to turn them off.
    if (automatic) await configuredInbox.enableInvestigations();
    else await configuredInbox.disableInvestigations();
    let backgroundChecks: boolean | undefined;
    if (fix && repositoryId !== undefined && releasesId !== undefined) {
      const offers = await workspace.listPreApprovableActions();
      // Marking a verified fix's issue resolved is the inbox's to do without asking; the
      // binding offers no other write.
      const resolving = offers.find(
        (offered) => offered.gatekeeperId === releasesId && offered.actionKind.tag === RESOLVE_WORKER_ISSUE,
      );
      if (!resolving) throw new Error("Resolving this Worker's issues could not be approved.");
      if (!resolving.alreadyEnabled) await workspace.setAutoApprovedActionKind(releasesId, resolving.actionKind);
      // Only the kinds the repository binding offers: pushing (never force, only to its prefix)
      // and opening a merge or pull request. Merging is never auto-approvable; it stays a person's.
      for (const offered of offers) {
        if (offered.gatekeeperId === repositoryId && !offered.alreadyEnabled)
          await workspace.setAutoApprovedActionKind(repositoryId, offered.actionKind);
      }
      await configuredInbox.enableFixes();
      // Without them the inbox still follows releases whenever it is opened, so fixes stand.
      backgroundChecks = await enableBackgroundChecks(api, workspace, gadget, metadata.defaultGadgetId ?? 0).then(
        () => true,
        () => false,
      );
    } else if (scope.fixes) {
      // The new investigator has no repository, so runs must not be dispatched as fixes.
      await configuredInbox.disableFixes();
    }
    // The notification may have been investigated meanwhile, from the inbox: setup still stands.
    const investigated = request.runKey
      ? await configuredInbox.investigateNotification(request.runKey).then(
          () => true,
          () => false,
        )
      : undefined;
    return {
      workspaceId: metadata.id,
      destinationId: destination.webhookId,
      investigationsEnabled: automatic,
      fixesEnabled: Boolean(fix),
      ...(backgroundChecks === undefined ? {} : { backgroundChecks }),
      ...(investigated === undefined ? {} : { investigated }),
    };
  }

  await workspace.setTitle(`${request.workerName} issue inbox`);
  await inbox.initialize({ accountId: request.accountId, workerName: request.workerName });
  const notifications = (await gadget.listBindings()).find(
    (binding) => binding.name === "CLOUDFLARE_NOTIFICATIONS",
  )?.target;
  const hook = (await workspace.listHooks()).find(
    (candidate) =>
      candidate.gadgetId === (metadata.defaultGadgetId ?? 0) && candidate.gatekeeperId === notifications,
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
