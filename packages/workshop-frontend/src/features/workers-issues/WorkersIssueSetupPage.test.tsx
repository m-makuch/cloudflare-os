// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountsSubscriberAdapter } from "../../accountsSubscriber";
import type {
  AgentSpawnerConfig,
  AuthenticatedApi,
  GatekeeperClient,
} from "@gadgets/workshop-shared/api";
import type { WorkerIssueInbox } from "../../../../bundled-blueprints/blueprints/workers-issues/files/lib/protocol";
import { WorkersIssueSetupPage } from "./WorkersIssueSetupPage";
import {
  NOTIFICATIONS_PATTERN,
  ACCOUNT_OBSERVABILITY_PATTERN,
  RELEASES_PATTERN,
  WORKER_PATTERN,
} from "./useWorkersIssueConnections";

let api: object;
vi.mock("../../AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }));
vi.mock("../../connectHandoff", () => ({
  openConnectWindow: vi.fn<() => Promise<string>>().mockResolvedValue("opened"),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request = {
  state: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  accountId: "a".repeat(32),
  workerName: "checkout-test",
  dashboardOrigin: "https://dash.cloudflare.com",
};
const workspaceId = "b".repeat(64);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

const render = async (
  options: {
    failEnable?: boolean;
    needsGrant?: boolean;
    noModels?: boolean;
    investigation?: boolean;
    wrongScope?: boolean;
    accounts?: number[];
    wrongAccount?: number;
    configuratorError?: string;
    existingInvestigator?: boolean;
    configuredModelId?: string;
    configuredDurationMs?: number;
    configuredTelemetryScope?: "worker" | "account";
    autoResolve?: boolean;
    investigationsEnabled?: boolean;
    bindFailure?: boolean;
    spawnerFailure?: boolean;
    remediation?: { allowPublic: boolean; repositoryUrl?: string };
    repositoryUrl?: string;
    publicRepository?: boolean;
    restricted?: boolean;
    /** Opened from the inbox: no dashboard origin, optionally for one stored notification. */
    fromInbox?: { runKey?: string };
    fixesEnabled?: boolean;
    /** Scheduled Tasks: provisioned (default), only offered, or disabled by the deployment. */
    scheduler?: "provisioned" | "offered" | "disabled";
  } = {},
) => {
  let subscriber: AccountsSubscriberAdapter;
  const addAccount = (id: number) =>
    subscriber.add(
      id,
      {
        displayName: `Example connection ${id}`,
        uniqueName: `user-${id}`,
        avatar: { url: "https://example.test/avatar" },
      },
      { displayName: "Cloudflare", url: "https://example.test" },
      [],
      true,
      "cloudflare",
    );
  const inbox = {
    initialize: vi.fn<WorkerIssueInbox["initialize"]>().mockResolvedValue(undefined),
    getSetupStatus: vi.fn<WorkerIssueInbox["getSetupStatus"]>().mockResolvedValue({
      accountId: request.accountId,
      workerName: options.wrongScope ? "other-worker" : request.workerName,
      investigationsEnabled: options.investigationsEnabled ?? false,
      investigatorReady: Boolean(options.existingInvestigator),
      releasesReady: false,
      backgroundChecks: false,
      autoResolve: options.autoResolve ?? true,
      ...(options.fixesEnabled
        ? {
            fixes: {
              provider: "github",
              repository: "acme/checkout",
              branchPrefix: "cloudflare-os/",
            },
          }
        : {}),
    }),
    enableInvestigations: vi
      .fn<WorkerIssueInbox["enableInvestigations"]>()
      .mockResolvedValue(undefined),
    disableInvestigations: vi
      .fn<WorkerIssueInbox["disableInvestigations"]>()
      .mockResolvedValue(undefined),
    investigateNotification: vi
      .fn<WorkerIssueInbox["investigateNotification"]>()
      .mockResolvedValue(undefined),
    disableFixes: vi.fn<WorkerIssueInbox["disableFixes"]>().mockResolvedValue(undefined),
    setAutomaticResolution: vi
      .fn<WorkerIssueInbox["setAutomaticResolution"]>()
      .mockResolvedValue(undefined),
    enableBackgroundChecks: vi
      .fn<WorkerIssueInbox["enableBackgroundChecks"]>()
      .mockResolvedValue(undefined),
    enableFixes: vi.fn<WorkerIssueInbox["enableFixes"]>().mockResolvedValue({
      provider: "github",
      repository: "acme/checkout",
      branchPrefix: "cloudflare-os/",
    }),
    getNotificationStatus: vi
      .fn<WorkerIssueInbox["getNotificationStatus"]>()
      .mockResolvedValue({ installed: true, suspended: false, webhookId: "destination-1" }),
    [Symbol.dispose]() {},
  };
  let bindings = [
    { name: "CLOUDFLARE_NOTIFICATIONS", target: 3 },
    ...(options.existingInvestigator ? [{ name: "INVESTIGATOR", target: 9 }] : []),
  ];
  const gadget = {
    connectToGadget: vi.fn<() => Promise<typeof inbox>>().mockResolvedValue(inbox),
    listBindings: vi.fn<() => Promise<typeof bindings>>(async () => bindings),
    unbind: vi.fn<(name: string) => Promise<void>>(async (name: string) => {
      bindings = bindings.filter((binding) => binding.name !== name);
    }),
    bind: vi.fn<(name: string, target: number) => Promise<void>>(
      async (name: string, target: number) => {
        if (options.bindFailure && target === 6) throw new Error("Binding failed");
        bindings.push({ name, target });
      },
    ),
    [Symbol.dispose]() {},
  };
  const telemetry = {
    getId: async () => 5,
    remove: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    [Symbol.dispose]() {},
  };
  const investigator = {
    getId: async () => 6,
    remove: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    [Symbol.dispose]() {},
  };
  const repository = {
    getId: async () => 8,
    remove: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    openSession: async () => ({
      getMetadata: async () => ({ visibility: options.publicRepository ? "public" : "private" }),
      [Symbol.dispose]() {},
    }),
    [Symbol.dispose]() {},
  };
  const releases = {
    getId: async () => 10,
    remove: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    [Symbol.dispose]() {},
  };
  const scheduler = { getId: async () => 11, [Symbol.dispose]() {} };
  let schedulerProvisioned = (options.scheduler ?? "provisioned") === "provisioned";
  const provisionAmbientAccount = vi.fn<(vendorId: string) => Promise<void>>(async () => {
    if (options.scheduler === "disabled") throw new Error("Scheduled Tasks are disabled.");
    schedulerProvisioned = true;
  });
  const workspace = {
    getGatekeeperById: vi.fn<
      () => Promise<Pick<GatekeeperClient<never>, "getCreationSpec"> & Disposable>
    >(async () => ({
      getCreationSpec: async () => ({
        type: "agentSpawner",
        config: {
          displayName: "Worker issue investigator",
          modelId: options.configuredModelId ?? "model-2",
          maxDurationMs: options.configuredDurationMs,
        },
      }),
      getBinding: async () => ({
        getCreationSpec: async () => ({
          type: "gatekeeper",
          vendorId: "cloudflare",
          typeUrlPattern:
            options.configuredTelemetryScope === "account"
              ? ACCOUNT_OBSERVABILITY_PATTERN
              : WORKER_PATTERN,
          resourceUrl:
            options.configuredTelemetryScope === "account"
              ? `https://dash.cloudflare.com/${request.accountId}/workers-and-pages/observability`
              : `https://dash.cloudflare.com/${request.accountId}/workers/services/view/${request.workerName}/production/observability`,
        }),
        [Symbol.dispose]() {},
      }),
      [Symbol.dispose]() {},
    })),
    getAmbientGatekeeper: vi.fn<(vendorId: string) => Promise<object | null>>(async (vendorId) =>
      vendorId === "scheduler" && schedulerProvisioned ? scheduler : null,
    ),
    getMetadata: vi.fn<() => Promise<object>>().mockResolvedValue({
      id: workspaceId,
      defaultGadgetId: 0,
      containsRestrictedData: options.restricted ?? false,
    }),
    setTitle: vi.fn<(title: string) => void>(),
    getGadget: vi.fn<() => Promise<typeof gadget>>().mockResolvedValue(gadget),
    newGatekeeper: vi.fn<(accountId: number, url: string) => Promise<object>>(
      async (_accountId: number, url: string) =>
        url.startsWith("https://github.com/")
          ? repository
          : url.endsWith("/deployments")
            ? releases
            : telemetry,
    ),
    listPreApprovableActions: vi.fn<() => Promise<object[]>>().mockResolvedValue([
      {
        gatekeeperId: 8,
        actionKind: { tag: "github.push", label: "Push commits" },
        alreadyEnabled: false,
      },
      {
        gatekeeperId: 8,
        actionKind: { tag: "github.createPullRequest", label: "Create pull requests" },
        alreadyEnabled: false,
      },
      {
        gatekeeperId: 5,
        actionKind: { tag: "cloudflare.other", label: "Other" },
        alreadyEnabled: false,
      },
      {
        gatekeeperId: 10,
        actionKind: { tag: "resolve-worker-issue", label: "Resolve Worker issues" },
        alreadyEnabled: false,
      },
    ]),
    setAutoApprovedActionKind: vi
      .fn<(id: number, kind: object) => Promise<void>>()
      .mockResolvedValue(undefined),
    newAgentSpawnerGatekeeper: vi
      .fn<(config: AgentSpawnerConfig) => Promise<typeof investigator>>()
      .mockResolvedValue(investigator),
    listHooks: vi.fn<() => Promise<object[]>>().mockResolvedValue([
      { id: 2, gadgetId: 0, gatekeeperId: 11, enabled: false },
      { id: 1, gadgetId: 0, gatekeeperId: 3, enabled: false },
    ]),
    enableHook: options.failEnable
      ? vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Provider unavailable"))
      : vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    [Symbol.dispose]() {},
  };
  if (options.spawnerFailure)
    workspace.newAgentSpawnerGatekeeper.mockRejectedValue(new Error("Spawner failed"));
  const create = vi
    .fn<(...args: unknown[]) => Promise<typeof workspace>>()
    .mockResolvedValue(workspace);
  const open = vi
    .fn<(...args: unknown[]) => Promise<typeof workspace>>()
    .mockResolvedValue(workspace);
  const ensure = vi
    .fn<(...args: unknown[]) => Promise<{ url: string; nonce: string } | null>>()
    .mockResolvedValue(null);
  if (options.needsGrant)
    ensure.mockResolvedValueOnce({ url: "https://example.test/connect", nonce: "c".repeat(64) });
  const listModels = vi.fn<AuthenticatedApi["listModels"]>().mockResolvedValue(
    options.noModels
      ? []
      : [
          { type: "agent", id: "model-1", name: "Other model" },
          { type: "agent", id: "model-2", name: "Preferred model" },
        ],
  );
  const getPreferredModel = vi
    .fn<AuthenticatedApi["getPreferredModel"]>()
    .mockResolvedValue("model-2");
  const configurator = vi
    .fn<(id: number) => Promise<{ ui: object }>>()
    .mockImplementation(async (id: number) => {
      if (options.configuratorError) throw new Error(options.configuratorError);
      return {
        ui: {
          listAccounts: async () => [
            {
              value: options.wrongAccount === id ? "c".repeat(32) : request.accountId,
              title: "Example account",
            },
          ],
          [Symbol.dispose]() {},
        },
      };
    });
  api = {
    subscribeConnectedAccounts: async (value: AccountsSubscriberAdapter) => {
      subscriber = value;
      for (const id of options.accounts ?? [1]) addAccount(id);
      // A connected GitHub account, which the Cloudflare connection logic must ignore.
      value.add(
        7,
        { displayName: "octocat", avatar: { url: "https://example.test/avatar" } },
        { displayName: "GitHub", url: "https://github.com" },
        [],
        true,
        "github",
      );
      subscriber.ready();
      return { [Symbol.dispose]() {} };
    },
    listGatekeeperVendors: vi.fn<() => Promise<object[]>>().mockResolvedValue([
      {
        id: "github",
        description: { displayName: "GitHub", url: "https://github.com" },
        supportedResources: [
          {
            urlPattern: "https://github.com/:owner/:repo\\?branchPrefix=*",
            title: "",
            description: "",
          },
          { urlPattern: "https://github.com/:owner/:repo", title: "", description: "" },
        ],
      },
    ]),
    listModels,
    getPreferredModel,
    startResourceConfigurator: configurator,
    connectAccount: vi
      .fn<() => Promise<object>>()
      .mockResolvedValue({ url: "https://example.test/connect", nonce: "c".repeat(64) }),
    ensureAccountResources: ensure,
    provisionAmbientAccount,
    newWorkspaceFromBlueprint: create,
    openWorkspace: open,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const { dashboardOrigin, ...inboxRequest } = request;
  const setupRequest = options.investigation
    ? {
        ...(options.fromInbox ? inboxRequest : { ...inboxRequest, dashboardOrigin }),
        investigation: { workspaceId, destinationId: "destination-1" },
        ...(options.remediation ? { remediation: options.remediation } : {}),
        ...(options.fromInbox?.runKey ? { runKey: options.fromInbox.runKey } : {}),
      }
    : { ...request, repositoryUrl: options.repositoryUrl };
  await act(async () => root!.render(<WorkersIssueSetupPage request={setupRequest} />));
  const submit = () =>
    [...container!.querySelectorAll("button")].find((button) =>
      ["Enable fixes", "Enable investigations", "Connect destination"].includes(
        button.textContent ?? "",
      ),
    )!;
  const completion = () => {
    const postMessage = vi.fn<Window["postMessage"]>();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: request.dashboardOrigin,
        source: { postMessage } as unknown as Window,
        data: { type: "cloudflare-os:workers-issues:status", state: request.state },
      }),
    );
    return postMessage;
  };
  return {
    workspace,
    inbox,
    gadget,
    telemetry,
    investigator,
    repository,
    releases,
    provisionAmbientAccount,
    create,
    open,
    ensure,
    submit,
    addAccount,
    listModels,
    getPreferredModel,
    completion,
  };
};

const selectOption = async (name: string, label: string) => {
  const control = [...container!.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element
        .getAttribute("aria-labelledby")
        ?.split(" ")
        .some((id) => document.getElementById(id)?.textContent?.includes(name)),
  )!;
  await act(async () => control.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent === label,
  )!;
  await act(async () => {
    option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option.click();
  });
};
const selectTelemetry = (label: string) => selectOption("Telemetry access", label);

describe("Destination-first Worker issue onboarding", () => {
  it("configures the model, scope, deadline, automatic runs and fixes during the initial connection", async () => {
    const fixture = await render({ repositoryUrl: "https://github.com/acme/checkout" });
    await act(async () => switchLabelled("Enable AI investigations").click());
    await act(async () =>
      [...container!.querySelectorAll("button")]
        .find((button) => button.textContent === "Change")!
        .click(),
    );
    await selectOption("Investigation model", "Other model");
    await selectOption("Time limit per investigation", "No time limit");
    await selectTelemetry("All Workers in this account");
    await act(async () => switchLabelled("Investigate new notifications automatically").click());
    await act(async () => switchLabelled("Propose fixes as pull or merge requests").click());
    expect(
      container!.querySelector<HTMLInputElement>(
        'input[placeholder="https://github.com/owner/repo"]',
      )?.value,
    ).toBe("https://github.com/acme/checkout");
    expect(switchLabelled("Allow public repositories").getAttribute("aria-checked")).toBe("false");
    await act(async () =>
      switchLabelled("Mark issue as resolved after the fix is deployed automatically").click(),
    );
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")).toBeNull();
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.ensure).toHaveBeenCalledWith(1, [
      NOTIFICATIONS_PATTERN,
      ACCOUNT_OBSERVABILITY_PATTERN,
      RELEASES_PATTERN,
    ]);
    expect(fixture.inbox.initialize).toHaveBeenCalledWith({
      accountId: request.accountId,
      workerName: request.workerName,
    });
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith({
      displayName: "Worker issue fixer",
      modelId: "model-1",
      env: { WORKER_OBSERVABILITY: 5, REPOSITORY: 8 },
    });
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      1,
      `https://dash.cloudflare.com/${request.accountId}/workers-and-pages/observability`,
    );
    expect(fixture.inbox.disableInvestigations).toHaveBeenCalled();
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
    expect(fixture.inbox.setAutomaticResolution).toHaveBeenCalledWith(false);
    expect(fixture.completion()).toHaveBeenCalledWith(
      expect.objectContaining({ fixesEnabled: true, investigationsEnabled: false }),
      { targetOrigin: request.dashboardOrigin },
    );
    expect(container!.textContent).toContain("Return to the dashboard to save your automation");
  });

  it("connects only notifications after opting back out of AI, even with models already loaded", async () => {
    const fixture = await render({ repositoryUrl: "https://github.com/acme/checkout" });
    await act(async () => switchLabelled("Enable AI investigations").click());
    await act(async () => switchLabelled("Propose fixes as pull or merge requests").click());
    await act(async () => switchLabelled("Enable AI investigations").click());
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenLastCalledWith(1, [NOTIFICATIONS_PATTERN]);
    expect(fixture.workspace.newGatekeeper).not.toHaveBeenCalled();
    expect(fixture.workspace.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
    expect(fixture.completion()).toHaveBeenCalledWith(
      expect.objectContaining({ investigationsEnabled: false }),
      { targetOrigin: request.dashboardOrigin },
    );
  });

  it("reuses the initial destination when AI configuration fails and setup is retried", async () => {
    const fixture = await render({ spawnerFailure: true });
    await act(async () => switchLabelled("Enable AI investigations").click());
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")?.textContent).toContain("Spawner failed");
    expect(fixture.completion()).not.toHaveBeenCalled();
    fixture.workspace.newAgentSpawnerGatekeeper.mockResolvedValue(fixture.investigator);
    await act(async () => fixture.submit().click());
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.enableInvestigations).toHaveBeenCalled();
    expect(fixture.completion()).toHaveBeenCalledWith(
      expect.objectContaining({ investigationsEnabled: true }),
      { targetOrigin: request.dashboardOrigin },
    );
  });

  it("identifies missing installation configuration instead of suggesting an account-access retry", async () => {
    const fixture = await render({
      configuratorError: "The Cloudflare Gatekeeper is not configured.",
    });
    expect(container!.querySelector("[role=alert]")?.textContent).toContain(
      "Cloudflare authorization is not configured on this OS installation",
    );
    expect(fixture.submit().disabled).toBe(true);
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("connects notifications without loading models, granting telemetry, or spawning an investigator", async () => {
    const fixture = await render({ noModels: true });
    expect(fixture.submit().disabled).toBe(false);
    expect(container!.querySelector('[aria-label="Cloudflare connection"]')).toBeNull();
    expect(
      [...container!.querySelectorAll("button")].some(
        (button) => button.textContent === "Connect Cloudflare",
      ),
    ).toBe(false);
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(1, [NOTIFICATIONS_PATTERN]);
    expect(fixture.create).toHaveBeenCalledWith("automation.workers-issues", {
      CLOUDFLARE_NOTIFICATIONS: {
        type: "gatekeeper",
        accountId: 1,
        resourceUrl: `https://dash.cloudflare.com/${request.accountId}/notifications`,
      },
    });
    expect(fixture.listModels).not.toHaveBeenCalled();
    expect(fixture.getPreferredModel).not.toHaveBeenCalled();
    expect(fixture.workspace.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
    // Only the notification subscription; any other hook of the inbox is not setup's to enable here.
    expect(fixture.workspace.enableHook.mock.calls).toEqual([[1]]);
    expect(fixture.completion()).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationId: "destination-1",
        workspaceId,
        investigationsEnabled: false,
        investigateCurrent: false,
      }),
      { targetOrigin: request.dashboardOrigin },
    );
  });

  it("continues automatically when missing authorization is redeemed", async () => {
    const fixture = await render({ needsGrant: true });
    await act(async () => {
      fixture.submit().click();
      await Promise.resolve();
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("finish it to continue automatically");
    await act(async () => fixture.addAccount(1));
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("Cloudflare OS is connected");
  });

  it("picks the sole connection that can access the originating account", async () => {
    const fixture = await render({ accounts: [1, 2], wrongAccount: 1 });
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(2, [NOTIFICATIONS_PATTERN]);
  });

  it("requires an explicit choice when multiple suitable connections remain", async () => {
    const fixture = await render({ accounts: [1, 2] });
    expect(fixture.submit().disabled).toBe(true);
    expect(container!.textContent).toContain("Cloudflare connection");
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("connects a missing identity and resumes without a second setup click", async () => {
    const fixture = await render({ accounts: [] });
    await act(async () => {
      fixture.submit().click();
      await Promise.resolve();
    });
    await act(async () => fixture.addAccount(4));
    expect(fixture.create).toHaveBeenCalledWith(
      "automation.workers-issues",
      expect.objectContaining({
        CLOUDFLARE_NOTIFICATIONS: expect.objectContaining({ accountId: 4 }),
      }),
    );
  });

  it("reuses a partially created inbox when hook setup fails", async () => {
    const fixture = await render({ failEnable: true });
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")?.textContent).toContain(
      "Setup could not finish",
    );
    fixture.workspace.enableHook.mockResolvedValue(undefined);
    await act(async () => fixture.submit().click());
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.open).toHaveBeenCalledWith(workspaceId);
  });

  it("uses the preferred model only at explicit AI opt-in, binding only Worker telemetry", async () => {
    const fixture = await render({ investigation: true });
    expect(container!.textContent).toContain("Model: Preferred model");
    expect(container!.textContent).not.toContain("Investigation model");
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(1, [WORKER_PATTERN]);
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      1,
      `https://dash.cloudflare.com/${request.accountId}/workers/services/view/checkout-test/production/observability`,
    );
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith({
      displayName: "Worker issue investigator",
      modelId: "model-2",
      maxDurationMs: 900_000,
      env: { WORKER_OBSERVABILITY: 5 },
    });
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 6);
    expect(fixture.inbox.enableInvestigations).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.initialize).not.toHaveBeenCalled();
    expect(fixture.completion()).toHaveBeenCalledWith(
      expect.objectContaining({ investigationsEnabled: true, investigateCurrent: false }),
      expect.anything(),
    );
  });

  it("cannot add an investigator to another Worker inbox", async () => {
    const fixture = await render({ investigation: true, wrongScope: true });
    await act(async () => fixture.submit().click());
    expect(fixture.workspace.newGatekeeper).not.toHaveBeenCalled();
    expect(fixture.inbox.enableInvestigations).not.toHaveBeenCalled();
    expect(fixture.completion()).not.toHaveBeenCalled();
    expect(container!.querySelector("[role=alert]")?.textContent).toContain("does not match");
  });

  it("grants account-wide read-only telemetry only when selected", async () => {
    const fixture = await render({ investigation: true });
    expect(container!.textContent).toContain("checkout-test only");
    await selectTelemetry("All Workers in this account");
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(1, [ACCOUNT_OBSERVABILITY_PATTERN]);
    expect(fixture.workspace.newGatekeeper.mock.calls).toEqual([
      [1, `https://dash.cloudflare.com/${request.accountId}/workers-and-pages/observability`],
    ]);
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith(
      expect.objectContaining({ env: { WORKER_OBSERVABILITY: 5 } }),
    );
    expect(fixture.workspace.setAutoApprovedActionKind).not.toHaveBeenCalled();
  });

  it("retains account-wide telemetry from the existing investigator's binding", async () => {
    const fixture = await render({
      investigation: true,
      existingInvestigator: true,
      configuredTelemetryScope: "account",
    });
    expect(container!.textContent).toContain("All Workers in this account");
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(1, [ACCOUNT_OBSERVABILITY_PATTERN]);
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      1,
      `https://dash.cloudflare.com/${request.accountId}/workers-and-pages/observability`,
    );
  });

  it("replaces account-wide telemetry with an exact Worker binding when narrowed", async () => {
    const fixture = await render({
      investigation: true,
      existingInvestigator: true,
      configuredTelemetryScope: "account",
    });
    await selectTelemetry("checkout-test only");
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(1, [WORKER_PATTERN]);
    expect(fixture.workspace.newGatekeeper.mock.calls).toEqual([
      [
        1,
        `https://dash.cloudflare.com/${request.accountId}/workers/services/view/checkout-test/production/observability`,
      ],
    ]);
    expect(fixture.gadget.unbind).toHaveBeenCalledWith("INVESTIGATOR");
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 6);
  });

  it("keeps release and repository permissions narrow with account-wide telemetry", async () => {
    const fixture = await render({
      investigation: true,
      existingInvestigator: true,
      configuredTelemetryScope: "account",
      remediation: { allowPublic: false, repositoryUrl: "https://github.com/acme/checkout" },
    });
    await act(async () => fixture.submit().click());
    expect(fixture.ensure).toHaveBeenCalledWith(1, [
      ACCOUNT_OBSERVABILITY_PATTERN,
      RELEASES_PATTERN,
    ]);
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      1,
      `https://dash.cloudflare.com/${request.accountId}/workers/services/view/checkout-test/production/deployments`,
    );
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith(
      expect.objectContaining({ env: { WORKER_OBSERVABILITY: 5, REPOSITORY: 8 } }),
    );
    expect(fixture.workspace.setAutoApprovedActionKind.mock.calls.map(([id]) => id)).not.toContain(
      5,
    );
  });

  it("replaces an existing investigator even when investigations are already enabled", async () => {
    const fixture = await render({
      investigation: true,
      existingInvestigator: true,
      investigationsEnabled: true,
    });
    await act(async () => fixture.submit().click());
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "model-2", env: { WORKER_OBSERVABILITY: 5 } }),
    );
    expect(fixture.gadget.unbind).toHaveBeenCalledWith("INVESTIGATOR");
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 6);
    expect(fixture.investigator.remove).not.toHaveBeenCalled();
  });

  it("shows and retains the inbox's configured model instead of the preferred model", async () => {
    const fixture = await render({
      investigation: true,
      fromInbox: {},
      existingInvestigator: true,
      configuredModelId: "model-1",
    });
    expect(container!.textContent).toContain("Model: Other model");
    await act(async () =>
      [...container!.querySelectorAll("button")]
        .find((button) => button.textContent === "Change")!
        .click(),
    );
    expect(container!.querySelector('[role="combobox"]')?.textContent).toContain("Other model");
    await act(async () => fixture.submit().click());
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "model-1" }),
    );
  });

  it("requires a new model choice when the previously configured model is unavailable", async () => {
    const fixture = await render({
      investigation: true,
      fromInbox: {},
      existingInvestigator: true,
      configuredModelId: "removed-model",
    });
    expect(fixture.submit().disabled).toBe(true);
    expect(container!.textContent).not.toContain("Model: Preferred model");
    expect(fixture.workspace.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
  });

  it.each([300_000, 420_000, undefined])(
    "retains the configured investigation limit (%s)",
    async (configuredDurationMs) => {
      const fixture = await render({
        investigation: true,
        existingInvestigator: true,
        configuredDurationMs,
      });
      expect(container!.querySelector('[role="combobox"]')?.textContent).toContain(
        configuredDurationMs === undefined
          ? "No time limit"
          : `${configuredDurationMs / 60_000} minutes`,
      );
      await act(async () => fixture.submit().click());
      const config = fixture.workspace.newAgentSpawnerGatekeeper.mock.calls[0]?.[0];
      expect(config).toEqual({
        displayName: "Worker issue investigator",
        modelId: "model-2",
        env: { WORKER_OBSERVABILITY: 5 },
        ...(configuredDurationMs === undefined ? {} : { maxDurationMs: configuredDurationMs }),
      });
    },
  );

  it("removes new workpieces and restores the previous investigator when binding fails", async () => {
    const fixture = await render({
      investigation: true,
      existingInvestigator: true,
      bindFailure: true,
    });
    await act(async () => fixture.submit().click());
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 9);
    expect(fixture.investigator.remove).toHaveBeenCalledTimes(1);
    expect(fixture.telemetry.remove).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.enableInvestigations).not.toHaveBeenCalled();
  });

  it("removes telemetry if creating the investigator fails", async () => {
    const fixture = await render({ investigation: true, spawnerFailure: true });
    await act(async () => fixture.submit().click());
    expect(fixture.telemetry.remove).toHaveBeenCalledTimes(1);
    expect(fixture.gadget.bind).not.toHaveBeenCalled();
  });

  it("keeps notifications available when no AI model has been configured", async () => {
    const fixture = await render({ investigation: true, noModels: true });
    expect(fixture.submit().disabled).toBe(true);
    expect(container!.textContent).toContain("Your notification destination is already connected");
    expect(fixture.workspace.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
  });
});

const switchLabelled = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("[role=switch]")].find((element) =>
    element.closest("label, div")?.textContent?.includes(text),
  )!;

describe("Worker issue fixes", () => {
  const remediation = {
    allowPublic: false,
    repositoryUrl: "https://github.com/acme/checkout",
  };
  const CONTRIBUTOR = "https://github.com/:owner/:repo\\?branchPrefix=*";

  it("connects a contributor repository for the fixer and inbox, approving its pushes and requests at setup", async () => {
    const fixture = await render({ investigation: true, investigationsEnabled: true, remediation });
    expect(container!.textContent).toContain("Enable AI fixes");
    expect(
      container!.querySelector<HTMLInputElement>(
        'input[placeholder="https://github.com/owner/repo"]',
      )?.value,
    ).toBe(remediation.repositoryUrl);
    await act(async () => fixture.submit().click());

    expect(fixture.ensure).toHaveBeenCalledWith(1, [WORKER_PATTERN, RELEASES_PATTERN]);
    expect(fixture.ensure).toHaveBeenCalledWith(7, [CONTRIBUTOR]);
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      7,
      "https://github.com/acme/checkout?branchPrefix=cloudflare-os%2F",
    );
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith({
      displayName: "Worker issue fixer",
      modelId: "model-2",
      maxDurationMs: 900_000,
      env: { WORKER_OBSERVABILITY: 5, REPOSITORY: 8 },
    });
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 6);
    expect(fixture.gadget.bind).toHaveBeenCalledWith("REPOSITORY", 8);
    expect(fixture.inbox.enableInvestigations).toHaveBeenCalled();
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
    expect(fixture.inbox.setAutomaticResolution).toHaveBeenCalledWith(true);
    // Only the repository binding's push and request kinds, and resolving the Worker's issues.
    expect(fixture.workspace.setAutoApprovedActionKind.mock.calls).toEqual([
      [10, { tag: "resolve-worker-issue", label: "Resolve Worker issues" }],
      [8, { tag: "github.push", label: "Push commits" }],
      [8, { tag: "github.createPullRequest", label: "Create pull requests" }],
    ]);
    const posted = fixture.completion();
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ fixesEnabled: true, investigationsEnabled: true }),
      { targetOrigin: request.dashboardOrigin },
    );
    expect(posted.mock.calls[0]![0]).not.toHaveProperty("backgroundChecks");
  });

  it("follows fixes to production: binds the Worker's releases and Scheduled Tasks, and turns on background checks", async () => {
    const fixture = await render({ investigation: true, investigationsEnabled: true, remediation });
    await act(async () => fixture.submit().click());
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      1,
      `https://dash.cloudflare.com/${request.accountId}/workers/services/view/checkout-test/production/deployments`,
    );
    // The inbox follows releases; the fixer never sees them.
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith(
      expect.objectContaining({ env: { WORKER_OBSERVABILITY: 5, REPOSITORY: 8 } }),
    );
    expect(fixture.gadget.bind).toHaveBeenCalledWith("WORKER_RELEASES", 10);
    expect(fixture.gadget.bind).toHaveBeenCalledWith("SCHEDULER", 11);
    expect(fixture.provisionAmbientAccount).not.toHaveBeenCalled();
    expect(fixture.inbox.enableBackgroundChecks).toHaveBeenCalledTimes(1);
    expect(fixture.workspace.enableHook.mock.calls).toEqual([[2]]);
    expect(container!.textContent).toContain("AI fixes are enabled.");
    expect(container!.textContent).not.toContain("Background checks could not");
  });

  it("opts into Scheduled Tasks when the deployment only offers them", async () => {
    const fixture = await render({
      investigation: true,
      investigationsEnabled: true,
      remediation,
      scheduler: "offered",
    });
    await act(async () => fixture.submit().click());
    expect(fixture.provisionAmbientAccount).toHaveBeenCalledWith("scheduler");
    expect(fixture.gadget.bind).toHaveBeenCalledWith("SCHEDULER", 11);
    expect(fixture.inbox.enableBackgroundChecks).toHaveBeenCalledTimes(1);
  });

  it("can propose fixes and follow deployments without approving automatic resolution", async () => {
    const fixture = await render({ investigation: true, remediation });
    expect(container!.textContent).not.toContain("Once you merge, the inbox follows");
    await act(async () =>
      switchLabelled("Mark issue as resolved after the fix is deployed automatically").click(),
    );
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.setAutomaticResolution).toHaveBeenCalledWith(false);
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
    expect(fixture.inbox.enableBackgroundChecks).toHaveBeenCalled();
    expect(fixture.workspace.setAutoApprovedActionKind.mock.calls).toEqual([
      [8, { tag: "github.push", label: "Push commits" }],
      [8, { tag: "github.createPullRequest", label: "Create pull requests" }],
    ]);
  });

  it("preserves automatic resolution being off when reopening and saving AI setup", async () => {
    const fixture = await render({
      investigation: true,
      fromInbox: {},
      remediation,
      fixesEnabled: true,
      autoResolve: false,
    });
    expect(
      switchLabelled("Mark issue as resolved after the fix is deployed automatically").getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.setAutomaticResolution).toHaveBeenCalledWith(false);
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
  });

  it("keeps older inboxes configurable, but requires a blueprint update before turning resolution off", async () => {
    const fixture = await render({ investigation: true, remediation });
    const status = await fixture.inbox.getSetupStatus();
    fixture.inbox.getSetupStatus.mockResolvedValue({ ...status, autoResolve: undefined });
    await act(async () =>
      switchLabelled("Mark issue as resolved after the fix is deployed automatically").click(),
    );
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")?.textContent).toContain("Update this inbox");
    expect(fixture.workspace.newGatekeeper).not.toHaveBeenCalled();
    await act(async () =>
      switchLabelled("Mark issue as resolved after the fix is deployed automatically").click(),
    );
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
    expect(fixture.inbox.setAutomaticResolution).not.toHaveBeenCalled();
  });

  it("keeps fixes enabled when background checks are unavailable", async () => {
    const fixture = await render({
      investigation: true,
      investigationsEnabled: true,
      remediation,
      scheduler: "disabled",
    });
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
    expect(fixture.inbox.enableBackgroundChecks).not.toHaveBeenCalled();
    expect(fixture.gadget.bind).not.toHaveBeenCalledWith("SCHEDULER", expect.anything());
    expect(container!.querySelector("[role=alert]")).toBeNull();
    expect(container!.textContent).toContain("Background checks could not be turned on");
  });

  it("does not enable fixes when resolving issues cannot be approved", async () => {
    const fixture = await render({ investigation: true, investigationsEnabled: true, remediation });
    fixture.workspace.listPreApprovableActions.mockResolvedValue([]);
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")?.textContent).toContain(
      "Resolving this Worker's issues could not be approved",
    );
    expect(fixture.inbox.enableFixes).not.toHaveBeenCalled();
  });

  it("refuses a public repository unless allowed, removing everything it created", async () => {
    const fixture = await render({
      investigation: true,
      investigationsEnabled: true,
      remediation,
      publicRepository: true,
    });
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")?.textContent).toContain(
      "This repository is public",
    );
    expect(fixture.repository.remove).toHaveBeenCalled();
    expect(fixture.releases.remove).toHaveBeenCalled();
    expect(fixture.telemetry.remove).toHaveBeenCalled();
    expect(fixture.workspace.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
    expect(fixture.gadget.bind).not.toHaveBeenCalled();
    expect(fixture.inbox.enableFixes).not.toHaveBeenCalled();
  });

  it("allows public repositories only after an explicit acknowledgment", async () => {
    const fixture = await render({
      investigation: true,
      investigationsEnabled: true,
      remediation,
      publicRepository: true,
    });
    await act(async () => switchLabelled("Allow public repositories").click());
    const allow = () =>
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow")!;
    expect(allow().disabled).toBe(true);
    const acknowledge = [...document.querySelectorAll<HTMLElement>("[role=checkbox]")].find(
      (element) => element.closest("label, div")?.textContent?.includes("visible to anyone"),
    )!;
    // Inside the dialog the checkbox builds a PointerEvent, which jsdom lacks; stand one in.
    const view: { PointerEvent?: typeof MouseEvent } = window;
    view.PointerEvent = MouseEvent;
    try {
      await act(async () => acknowledge.click());
    } finally {
      delete view.PointerEvent;
    }
    expect(allow().disabled).toBe(false);
    await act(async () => allow().click());
    await act(async () => fixture.submit().click());
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      7,
      "https://github.com/acme/checkout?branchPrefix=cloudflare-os%2F&allowPublic=true",
    );
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
  });

  it("refuses fixes in a workspace that has read restricted data, which could never push", async () => {
    const fixture = await render({
      investigation: true,
      investigationsEnabled: true,
      remediation,
      restricted: true,
    });
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")?.textContent).toContain("restricted data");
    expect(fixture.workspace.newGatekeeper).not.toHaveBeenCalled();
  });

  it("enables investigations alone when the user turns fixes off", async () => {
    const fixture = await render({ investigation: true, investigationsEnabled: true, remediation });
    await act(async () => switchLabelled("Propose fixes").click());
    const enable = [...container!.querySelectorAll("button")].find(
      (button) => button.textContent === "Enable investigations",
    )!;
    await act(async () => enable.click());
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.enableFixes).not.toHaveBeenCalled();
    expect(fixture.inbox.enableInvestigations).toHaveBeenCalled();
  });
});

describe("Worker issue setup opened from the inbox", () => {
  const runKey = `${request.accountId}:run-1`;

  it.each([false, true])(
    "preserves saved automatic investigations (%s) when updating setup",
    async (enabled) => {
      const fixture = await render({
        investigation: true,
        existingInvestigator: true,
        investigationsEnabled: enabled,
        fromInbox: {},
      });
      expect(
        switchLabelled("Investigate new notifications automatically").getAttribute("aria-checked"),
      ).toBe(String(enabled));
      await act(async () => fixture.submit().click());
      expect(
        enabled ? fixture.inbox.enableInvestigations : fixture.inbox.disableInvestigations,
      ).toHaveBeenCalledTimes(1);
      expect(
        enabled ? fixture.inbox.disableInvestigations : fixture.inbox.enableInvestigations,
      ).not.toHaveBeenCalled();
    },
  );

  it("can change the saved automatic investigations choice", async () => {
    const fixture = await render({
      investigation: true,
      existingInvestigator: true,
      investigationsEnabled: true,
      fromInbox: {},
    });
    await act(async () => switchLabelled("Investigate new notifications automatically").click());
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.disableInvestigations).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.enableInvestigations).not.toHaveBeenCalled();
  });

  it("binds an investigator for one notification without investigating every later one", async () => {
    const fixture = await render({ investigation: true, fromInbox: { runKey } });
    expect(
      switchLabelled("Investigate new notifications automatically").getAttribute("aria-checked"),
    ).toBe("false");
    // Fixes are offered, but off until the user asks.
    expect(switchLabelled("Propose fixes").getAttribute("aria-checked")).toBe("false");
    await act(async () => fixture.submit().click());
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 6);
    expect(fixture.inbox.enableInvestigations).not.toHaveBeenCalled();
    expect(fixture.inbox.disableInvestigations).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.investigateNotification).toHaveBeenCalledWith(runKey);
    expect(container!.textContent).toContain("The inbox is investigating the notification.");
    // No dashboard to report to.
    expect(fixture.completion()).not.toHaveBeenCalled();
  });

  it("still reports success when the notification was investigated meanwhile", async () => {
    const fixture = await render({ investigation: true, fromInbox: { runKey } });
    fixture.inbox.investigateNotification.mockRejectedValue(new Error("Already investigated"));
    await act(async () => fixture.submit().click());
    expect(container!.querySelector("[role=alert]")).toBeNull();
    expect(container!.textContent).toContain("already being investigated");
  });

  it("investigates every new notification when opened to enable investigations", async () => {
    const fixture = await render({ investigation: true, fromInbox: {} });
    expect(
      switchLabelled("Investigate new notifications automatically").getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.enableInvestigations).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.investigateNotification).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("return to the inbox");
  });

  it("keeps fixes on when the inbox that proposes them changes its setup", async () => {
    const fixture = await render({
      investigation: true,
      fromInbox: {},
      fixesEnabled: true,
      remediation: { allowPublic: false, repositoryUrl: "https://github.com/acme/checkout" },
    });
    expect(switchLabelled("Propose fixes").getAttribute("aria-checked")).toBe("true");
    expect(
      container!.querySelector<HTMLInputElement>(
        'input[placeholder="https://github.com/owner/repo"]',
      )?.value,
    ).toBe("https://github.com/acme/checkout");
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.enableFixes).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.disableFixes).not.toHaveBeenCalled();
  });

  it("turns off stored fixes when the replacement investigator has no repository", async () => {
    const fixture = await render({ investigation: true, fromInbox: {}, fixesEnabled: true });
    await act(async () => fixture.submit().click());
    expect(fixture.inbox.disableFixes).toHaveBeenCalledTimes(1);
    expect(fixture.inbox.enableFixes).not.toHaveBeenCalled();
  });
});
