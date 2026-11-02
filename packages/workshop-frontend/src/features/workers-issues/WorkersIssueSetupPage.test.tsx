// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountsSubscriberAdapter } from "../../accountsSubscriber";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { WorkerIssueInbox } from "../../../../bundled-blueprints/blueprints/workers-issues/files/protocol";
import { WorkersIssueSetupPage } from "./WorkersIssueSetupPage";
import { NOTIFICATIONS_PATTERN, WORKER_PATTERN } from "./useWorkersIssueConnections";

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
    investigationsEnabled?: boolean;
    bindFailure?: boolean;
    spawnerFailure?: boolean;
    remediation?: { approval: "ask" | "automatic"; allowPublic: boolean; repositoryUrl?: string };
    publicRepository?: boolean;
    restricted?: boolean;
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
    }),
    enableInvestigations: vi
      .fn<WorkerIssueInbox["enableInvestigations"]>()
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
  let bindings = options.existingInvestigator ? [{ name: "INVESTIGATOR", target: 9 }] : [];
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
  const workspace = {
    getMetadata: vi
      .fn<() => Promise<object>>()
      .mockResolvedValue({
        id: workspaceId,
        defaultGadgetId: 0,
        containsRestrictedData: options.restricted ?? false,
      }),
    setTitle: vi.fn<(title: string) => void>(),
    getGadget: vi.fn<() => Promise<typeof gadget>>().mockResolvedValue(gadget),
    newGatekeeper: vi.fn<(accountId: number, url: string) => Promise<object>>(
      async (_accountId: number, url: string) =>
        url.startsWith("https://github.com/") ? repository : telemetry,
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
    ]),
    setAutoApprovedActionKind: vi
      .fn<(id: number, kind: object) => Promise<void>>()
      .mockResolvedValue(undefined),
    newAgentSpawnerGatekeeper: vi
      .fn<() => Promise<typeof investigator>>()
      .mockResolvedValue(investigator),
    listHooks: vi
      .fn<() => Promise<object[]>>()
      .mockResolvedValue([{ id: 1, gadgetId: 0, enabled: false }]),
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
        { displayName: "octocat" },
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
    newWorkspaceFromBlueprint: create,
    openWorkspace: open,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const setupRequest = options.investigation
    ? {
        ...request,
        investigation: { workspaceId, destinationId: "destination-1" },
        ...(options.remediation ? { remediation: options.remediation } : {}),
      }
    : request;
  await act(async () => root!.render(<WorkersIssueSetupPage request={setupRequest} />));
  const submit = () =>
    [...container!.querySelectorAll("button")].find(
      (button) =>
        button.textContent ===
        (options.remediation
          ? "Enable fixes"
          : options.investigation
            ? "Enable investigations"
            : "Connect destination"),
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

describe("Destination-first Worker issue onboarding", () => {
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
    expect(fixture.workspace.enableHook).toHaveBeenCalledWith(1);
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
    approval: "ask" as const,
    allowPublic: false,
    repositoryUrl: "https://github.com/acme/checkout",
  };
  const CONTRIBUTOR = "https://github.com/:owner/:repo\\?branchPrefix=*";

  it("connects a contributor repository for the fixer and inbox, enabling fixes with approval required", async () => {
    const fixture = await render({ investigation: true, investigationsEnabled: true, remediation });
    expect(container!.textContent).toContain("Enable AI fixes");
    expect(container!.textContent).toContain("GitHub · acme/checkout");
    await act(async () => fixture.submit().click());

    expect(fixture.ensure).toHaveBeenCalledWith(7, [CONTRIBUTOR]);
    expect(fixture.workspace.newGatekeeper).toHaveBeenCalledWith(
      7,
      "https://github.com/acme/checkout?branchPrefix=cloudflare-os%2F",
    );
    expect(fixture.workspace.newAgentSpawnerGatekeeper).toHaveBeenCalledWith({
      displayName: "Worker issue fixer",
      modelId: "model-2",
      env: { WORKER_OBSERVABILITY: 5, REPOSITORY: 8 },
    });
    expect(fixture.gadget.bind).toHaveBeenCalledWith("INVESTIGATOR", 6);
    expect(fixture.gadget.bind).toHaveBeenCalledWith("REPOSITORY", 8);
    expect(fixture.inbox.enableInvestigations).toHaveBeenCalled();
    expect(fixture.inbox.enableFixes).toHaveBeenCalled();
    expect(fixture.workspace.setAutoApprovedActionKind).not.toHaveBeenCalled();
    expect(fixture.completion()).toHaveBeenCalledWith(
      expect.objectContaining({ fixesEnabled: true, investigationsEnabled: true }),
      { targetOrigin: request.dashboardOrigin },
    );
  });

  it("auto-approves only the repository binding's push and request kinds in automatic mode", async () => {
    const fixture = await render({
      investigation: true,
      investigationsEnabled: true,
      remediation: { ...remediation, approval: "automatic" },
    });
    await act(async () => fixture.submit().click());
    expect(fixture.workspace.setAutoApprovedActionKind.mock.calls).toEqual([
      [8, { tag: "github.push", label: "Push commits" }],
      [8, { tag: "github.createPullRequest", label: "Create pull requests" }],
    ]);
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
