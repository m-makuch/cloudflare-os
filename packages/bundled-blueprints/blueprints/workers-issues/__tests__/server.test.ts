// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gadget } from "../files/server.ts";

const { restore } = vi.hoisted(() => ({ restore: Symbol("restore") }));
vi.mock("cloudflare:workers", () => ({
  restore,
  RpcTarget: class {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  RpcStub: class {
    target: object;
    constructor(target: object) {
      this.target = target;
    }
  },
}));

const scope = { accountId: "a".repeat(32), workerName: "checkout-test" };
const notification = () => ({
  id: "envelope-1",
  accountId: scope.accountId,
  alertType: "workers_observability_real_time_issue",
  data: {
    state_event: "ALERT_STATE_EVENT_START",
    state_correlation_id: "run-1",
    issue: {
      id: "issue-1",
      services: [{ type: "SERVICE_TYPE_WORKER", name: scope.workerName }],
    },
  },
});
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

type Change = { id: string; url: string | null; state: string; merged?: boolean };

/** A contributor repository binding: metadata, and the requests listed per branch. */
const repository = (provider: "gitlab" | "github", metadata: Record<string, unknown> = {}) => {
  const changes = new Map<string, Change[]>();
  const list = vi.fn(async (options: { sourceBranch?: string; head?: string }) => {
    const rows = changes.get(options.sourceBranch ?? options.head ?? "") ?? [];
    return { next: async () => rows, [Symbol.dispose]: vi.fn() };
  });
  return {
    changes,
    list,
    binding: {
      getMetadata: vi.fn().mockResolvedValue({
        ...(provider === "github"
          ? { fullName: "acme/checkout", url: "https://github.com/acme/checkout" }
          : { path: "acme/checkout", url: "https://gitlab.example.com/acme/checkout" }),
        defaultBranch: "main",
        visibility: "private",
        branchPrefix: "cloudflare-os/",
        allowPublic: false,
        ...metadata,
      }),
      listMergeRequests: provider === "gitlab" ? list : vi.fn(),
      listPullRequests: provider === "github" ? list : vi.fn(),
    },
  };
};

const setup = (
  options: { repository?: ReturnType<typeof repository>; investigator?: boolean } = {},
) => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = new Map<string, unknown>();
  const investigate = vi.fn().mockResolvedValue(undefined);
  const fix = vi.fn().mockResolvedValue(undefined);
  const spawnCallable = vi.fn().mockResolvedValue({ investigate, fix, [Symbol.dispose]() {} });
  const subscribe = vi.fn().mockResolvedValue(undefined);
  let gadget: InstanceType<typeof Gadget>;
  const background: Promise<unknown>[] = [];
  /** Waits for the work the gadget handed to ctx.waitUntil(), including work that work started. */
  const settle = async () => {
    while (background.length) await Promise.all(background.splice(0));
  };
  const context = {
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: async (key: string) => storage.delete(key),
      // As in production, where a gadget is a Durable Object facet.
      setAlarm: vi.fn().mockRejectedValue(new Error("Facets currently cannot set alarms.")),
      sql: {
        exec: (sql: string, ...values: SQLInputValue[]) => {
          const rows = database.prepare(sql).all(...values);
          return { toArray: () => rows };
        },
      },
    },
    restore: async (params: object) =>
      Object.assign(Reflect.get(gadget, restore).call(gadget, params).target, {
        [Symbol.dispose]() {},
      }),
  };
  const env = {
    ...(options.investigator === false ? {} : { INVESTIGATOR: { spawnCallable } }),
    CLOUDFLARE_NOTIFICATIONS: { subscribe, getStatus: vi.fn() },
    ...(options.repository ? { REPOSITORY: options.repository.binding } : {}),
  };
  const restart = () => {
    gadget = new Gadget(context as unknown as DurableObjectState, env);
    return gadget;
  };
  return { gadget: restart(), restart, settle, spawnCallable, investigate, fix, subscribe, storage, context, database };
};

type Task = {
  getContext(): Promise<{ fix?: { branch: string; provider: string; repository: string } }>;
  reportChange(change: { id: string; url: string | null }): Promise<void>;
  complete(report: string): Promise<void>;
};

/**
 * An inbox with investigations and fixes enabled that has received one notification, whose run
 * starts at once; `fixer` configures the fixer's response first.
 */
const fixing = async (
  provider: "gitlab" | "github" = "gitlab",
  fixer?: (fix: ReturnType<typeof setup>["fix"]) => void,
) => {
  const repo = repository(provider);
  const fixture = setup({ repository: repo });
  fixer?.(fixture.fix);
  await fixture.gadget.initialize(scope);
  await fixture.gadget.enableInvestigations();
  await fixture.gadget.enableFixes();
  await fixture.gadget.onNotification(notification());
  return { ...fixture, repo };
};
const RUN = `${scope.accountId}:run-1`;

describe("Worker issue investigation inbox", () => {
  it("registers one external-policy hook, including concurrent initialization and restart", async () => {
    const fixture = setup();
    await Promise.all([fixture.gadget.initialize(scope), fixture.gadget.initialize(scope)]);
    await fixture.restart().initialize(scope);
    expect(fixture.subscribe).toHaveBeenCalledTimes(1);
    expect(fixture.subscribe).toHaveBeenCalledWith(expect.anything(), {
      alertType: "workers_observability_real_time_issue",
      createPolicy: false,
    });
    await expect(
      fixture.gadget.initialize({ ...scope, workerName: "other-worker" }),
    ).rejects.toThrow("different Worker");
  });

  it("deduplicates a logical run across envelopes and a process restart", async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    await fixture.restart().onNotification({ ...notification(), id: "envelope-2" });
    await fixture.settle();
    expect(fixture.spawnCallable).toHaveBeenCalledTimes(1);
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      {
        run_key: `${scope.accountId}:run-1`,
        issue_id: "issue-1",
        status: "queued",
      },
    ]);
  });

  it("ignores other accounts, other Workers, resolved events, and malformed service evidence", async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.onNotification({ ...notification(), accountId: "b".repeat(32) });
    const other = notification();
    other.data.issue.services[0]!.name = "other-worker";
    await fixture.gadget.onNotification(other);
    const resolved = notification();
    resolved.data.state_event = "ALERT_STATE_EVENT_END";
    await fixture.gadget.onNotification(resolved);
    await fixture.gadget.onNotification({ ...notification(), data: { issue: { services: {} } } });
    await fixture.gadget.onNotification({
      ...notification(),
      data: {
        state_event: "ALERT_STATE_EVENT_START",
        issue: { services: [null, 42] },
      },
    });
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous dispatch visible and never blindly sends it twice", async () => {
    const fixture = setup();
    fixture.investigate.mockRejectedValue(new Error("Connection lost after dispatch"));
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    await fixture.restart().onNotification({ ...notification(), id: "retry-envelope" });
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      { status: "delivery_unknown" },
    ]);
  });

  it("records findings through the task and does not overwrite completed reports with queued state", async () => {
    const fixture = setup();
    fixture.investigate.mockImplementation(
      async (task: { complete(report: string): Promise<void> }) =>
        task.complete(
          "Telemetry confirms a missing coupon TypeError. No source or project tests were accessed.",
        ),
    );
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      { status: "completed", has_report: true },
    ]);
    expect((await fixture.gadget.listInvestigations())[0]).not.toHaveProperty("report");
    expect(await fixture.gadget.getInvestigationReport(`${scope.accountId}:run-1`)).toContain(
      "No source or project tests",
    );
  });

  it("stores notifications without invoking a model until explicit opt-in, with no backfill", async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.onNotification(notification());
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "received" }]);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({
      ...scope,
      investigationsEnabled: false,
    });
    await fixture.gadget.enableInvestigations();
    await fixture.restart().onNotification(notification());
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    const next = notification();
    next.data.state_correlation_id = "run-2";
    await fixture.gadget.onNotification(next);
    await fixture.settle();
    expect(fixture.spawnCallable).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({ investigationsEnabled: true });
  });

  it("investigates one stored notification on request, once, without enabling automatic runs", async () => {
    const unbound = setup({ investigator: false });
    await unbound.gadget.initialize(scope);
    await unbound.gadget.onNotification(notification());
    expect(await unbound.gadget.getSetupStatus()).toMatchObject({ investigatorReady: false });
    await expect(unbound.gadget.investigateNotification(RUN)).rejects.toThrow("investigator");

    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.onNotification(notification());
    const next = notification();
    next.data.state_correlation_id = "run-2";
    await fixture.gadget.onNotification(next);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({
      investigationsEnabled: false,
      investigatorReady: true,
    });
    // A second concurrent click finds the run already claimed and is refused.
    const clicks = await Promise.allSettled([
      fixture.gadget.investigateNotification(RUN),
      fixture.gadget.investigateNotification(RUN),
    ]);
    expect(clicks.filter((click) => click.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await fixture.settle();
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    const runs = await fixture.gadget.listInvestigations();
    expect(runs.find((run) => run.run_key === RUN)).toMatchObject({ status: "queued", mode: "investigate" });
    expect(runs.find((run) => run.run_key !== RUN)).toMatchObject({ status: "received" });
    await expect(fixture.gadget.investigateNotification(RUN)).rejects.toThrow("not been investigated");
    await expect(fixture.gadget.investigateNotification("unknown")).rejects.toThrow(
      "not been investigated",
    );
  });

  it("stops starting runs on arrival once automatic investigations are turned off", async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.disableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "received" }]);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({ investigationsEnabled: false });
  });

  it("returns from the notification callback before allocation and accepts another run while allocation waits", async () => {
    const fixture = setup();
    const allocation = Promise.withResolvers<{
      investigate: typeof fixture.investigate;
      [Symbol.dispose](): void;
    }>();
    fixture.spawnCallable.mockReturnValueOnce(allocation.promise);
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "allocating" }]);
    await vi.waitFor(() => expect(fixture.spawnCallable).toHaveBeenCalledTimes(1));
    const next = notification();
    next.data.state_correlation_id = "run-2";
    await fixture.gadget.onNotification(next);
    expect(await fixture.gadget.listInvestigations()).toHaveLength(2);
    allocation.resolve({ investigate: fixture.investigate, [Symbol.dispose]() {} });
    await fixture.settle();
    expect(fixture.investigate).toHaveBeenCalledTimes(2);
  });

  it("allows explicit retry only after a definite allocation failure", async () => {
    const fixture = setup();
    fixture.spawnCallable.mockRejectedValueOnce(new Error("Model unavailable"));
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await Promise.all([
      fixture.gadget.onNotification(notification()),
      fixture.gadget.onNotification(notification()),
    ]);
    await fixture.settle();
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "failed" }]);
    await fixture.gadget.retryInvestigation(`${scope.accountId}:run-1`);
    await fixture.settle();
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    await expect(fixture.gadget.retryInvestigation(`${scope.accountId}:run-1`)).rejects.toThrow(
      "Only a failed",
    );
  });

  it("acknowledges conflicting issue identities without poisoning the existing run", async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.onNotification(notification());
    const conflicting = notification();
    conflicting.data.issue.id = "issue-2";
    await fixture.gadget.onNotification(conflicting);
    expect(fixture.storage.get("identityConflicts")).toBe(1);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ issue_id: "issue-1" }]);
  });

  it("fences a late allocation after a new facet retries the failed attempt", async () => {
    const fixture = setup();
    const allocation = Promise.withResolvers<{
      investigate: typeof fixture.investigate;
      [Symbol.dispose](): void;
    }>();
    fixture.spawnCallable.mockReturnValueOnce(allocation.promise);
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await vi.waitFor(() => expect(fixture.spawnCallable).toHaveBeenCalledTimes(1));
    const replacement = fixture.restart();
    expect(await replacement.listInvestigations()).toMatchObject([{ status: "failed" }]);
    await replacement.retryInvestigation(`${scope.accountId}:run-1`);
    await vi.waitFor(() => expect(fixture.investigate).toHaveBeenCalledTimes(1));
    allocation.resolve({ investigate: fixture.investigate, [Symbol.dispose]() {} });
    await fixture.settle();
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(await replacement.listInvestigations()).toMatchObject([{ status: "queued" }]);
  });
});

describe("Worker issue fixes", () => {
  it("requires an investigator and a contributor repository binding, and records the repository", async () => {
    const plain = setup();
    await plain.gadget.initialize(scope);
    await expect(plain.gadget.enableFixes()).rejects.toThrow("Connect a repository");

    const unbound = setup({ repository: repository("gitlab"), investigator: false });
    await unbound.gadget.initialize(scope);
    await expect(unbound.gadget.enableFixes()).rejects.toThrow("investigator");

    const full = setup({ repository: repository("gitlab", { branchPrefix: undefined }) });
    await full.gadget.initialize(scope);
    // A binding with the whole repository's surface is refused.
    await expect(full.gadget.enableFixes()).rejects.toThrow("contributor binding");

    const github = setup({ repository: repository("github") });
    await github.gadget.initialize(scope);
    await github.gadget.enableInvestigations();
    expect(await github.gadget.enableFixes()).toEqual({
      provider: "github", repository: "acme/checkout", branchPrefix: "cloudflare-os/",
    });
    expect(await github.gadget.getSetupStatus()).toMatchObject({
      fixes: { provider: "github", repository: "acme/checkout" },
    });
    await github.gadget.disableFixes();
    expect(await github.gadget.getSetupStatus()).not.toHaveProperty("fixes");
  });

  it("dispatches a fixer with a stable prefixed branch and the fix instructions", async () => {
    const fixture = await fixing();
    await fixture.settle();
    expect(fixture.investigate).not.toHaveBeenCalled();
    expect(fixture.fix).toHaveBeenCalledTimes(1);
    const [title, options] = fixture.spawnCallable.mock.calls[0]!;
    expect(title).toBe("Fix checkout-test: issue-1");
    expect(options.mainType).toBe("Fixer");
    // The instructions carry the scrubbing rule and forbid merging and deploying.
    expect(options.types).toMatch(/Scrub before committing/);
    expect(options.types).toMatch(/email addresses/);
    expect(options.types).toMatch(/Never merge it, deploy/);
    // A description must not claim verification nobody performed.
    expect(options.types).toMatch(/Report only verification you performed/);
    // The request is the only review: edits go in an in-memory worktree, never the mount.
    expect(options.types).toMatch(/env\.GIT\.newWorktree\(base\)/);
    expect(options.types).toMatch(/never write to or\s+\*\s+commit on that mount/);

    const task = fixture.fix.mock.calls[0]![0] as Task;
    const context = await task.getContext();
    expect(context.fix).toEqual({
      provider: "gitlab", repository: "acme/checkout", branch: expect.stringMatching(/^cloudflare-os\/fix\/issue-1-[0-9a-f]{10}$/),
    });
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      { status: "fixing", mode: "fix", fix_branch: context.fix!.branch },
    ]);
  });

  it("records a pending request, then its URL once the repository shows it", async () => {
    const fixture = await fixing();
    await fixture.settle();
    const task = fixture.fix.mock.calls[0]![0] as Task;
    const { fix } = await task.getContext();
    await expect(task.reportChange({ id: "42; drop", url: null })).rejects.toThrow();
    await expect(task.reportChange({ id: "42", url: "javascript:alert(1)" })).rejects.toThrow();
    await task.reportChange({ id: "~1", url: null });
    await task.complete("Fixed the missing coupon guard; added a regression test.");
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      { status: "push_pending", change_id: "~1", change_url: null, has_report: true },
    ]);

    // Approved and created: the repository now lists it.
    const url = "https://gitlab.example.com/acme/checkout/-/merge_requests/7";
    fixture.repo.changes.set(fix!.branch, [{ id: "7", url, state: "opened" }]);
    await fixture.gadget.reconcileChanges();
    expect(fixture.repo.list).toHaveBeenCalledWith({ sourceBranch: fix!.branch, state: "all", resultsPerPage: 10 });
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      { status: "change_opened", change_id: "7", change_url: url, change_state: "opened" },
    ]);
    // Read at most once a minute per run.
    await fixture.gadget.reconcileChanges();
    expect(fixture.repo.list).toHaveBeenCalledTimes(1);
  });

  it("reads GitHub pull requests by head and records a merge", async () => {
    const fixture = await fixing("github");
    await fixture.settle();
    const task = fixture.fix.mock.calls[0]![0] as Task;
    const { fix } = await task.getContext();
    await task.reportChange({ id: "~1", url: null });
    const url = "https://github.com/acme/checkout/pull/9";
    fixture.repo.changes.set(fix!.branch, [{ id: "9", url, state: "closed", merged: true }]);
    await fixture.gadget.reconcileChanges();
    expect(fixture.repo.list).toHaveBeenCalledWith({ head: fix!.branch, state: "all", resultsPerPage: 10 });
    expect(await fixture.gadget.listInvestigations()).toMatchObject([
      { status: "change_opened", change_id: "9", change_url: url, change_state: "merged" },
    ]);
  });

  it("checks the repository before retrying an unconfirmed fix, and reuses its branch", async () => {
    const fixture = await fixing("gitlab", (fix) =>
      fix.mockRejectedValueOnce(new Error("Connection lost after dispatch")),
    );
    await fixture.settle();
    const [run] = await fixture.gadget.listInvestigations();
    expect(run).toMatchObject({ status: "fix_unknown" });

    // The fixer got as far as opening its request: shown, not attempted again.
    const url = "https://gitlab.example.com/acme/checkout/-/merge_requests/8";
    fixture.repo.changes.set(run!.fix_branch!, [{ id: "8", url, state: "opened" }]);
    await fixture.gadget.retryInvestigation(RUN);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "change_opened", change_id: "8" }]);
    await fixture.settle();
    expect(fixture.fix).toHaveBeenCalledTimes(1);
  });

  it("retries an unconfirmed fix with nothing in the repository on the same branch", async () => {
    const fixture = await fixing("gitlab", (fix) =>
      fix.mockRejectedValueOnce(new Error("Connection lost after dispatch")),
    );
    await fixture.settle();
    const [before] = await fixture.gadget.listInvestigations();
    await fixture.gadget.retryInvestigation(RUN);
    await fixture.settle();
    expect(fixture.fix).toHaveBeenCalledTimes(2);
    const task = fixture.fix.mock.calls[1]![0] as Task;
    expect((await task.getContext()).fix!.branch).toBe(before!.fix_branch);
  });

  it("marks a fix lost to a restart mid-dispatch as unconfirmed, not as a lost investigation", async () => {
    const delivery = Promise.withResolvers<void>();
    const fixture = await fixing("gitlab", (fix) => fix.mockReturnValueOnce(delivery.promise));
    await vi.waitFor(() => expect(fixture.fix).toHaveBeenCalledTimes(1));
    expect(await fixture.restart().listInvestigations()).toMatchObject([{ status: "fix_unknown" }]);
  });

  it("keeps runs dispatched as investigations investigating after fixes are enabled", async () => {
    const repo = repository("gitlab");
    const fixture = setup({ repository: repo });
    fixture.spawnCallable.mockRejectedValueOnce(new Error("Model unavailable"));
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    await fixture.gadget.enableFixes();
    await fixture.gadget.retryInvestigation(RUN);
    await fixture.settle();
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(fixture.fix).not.toHaveBeenCalled();
  });

  it("proposes a fix for a stored notification on request when fixes are on but not automatic", async () => {
    const fixture = setup({ repository: repository("github") });
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableFixes();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    await fixture.gadget.investigateNotification(RUN);
    await fixture.settle();
    expect(fixture.fix).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "fixing", mode: "fix" }]);
  });

  it("refuses a change report from an investigation-only run", async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.settle();
    const task = fixture.investigate.mock.calls[0]![0] as Task;
    await expect(task.reportChange({ id: "1", url: null })).rejects.toThrow("cannot open");
  });

  it("adds the fix columns to an inbox created before fixes, keeping its rows", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`CREATE TABLE investigations (
      run_key TEXT PRIMARY KEY, issue_id TEXT NOT NULL, notification TEXT NOT NULL,
      status TEXT NOT NULL, report TEXT, created_at INTEGER NOT NULL)`);
    database.prepare("INSERT INTO investigations VALUES ('k', 'issue-0', '{}', 'completed', 'r', 1)").run();
    const context = {
      storage: {
        get: async () => undefined,
        sql: {
          exec: (sql: string, ...values: SQLInputValue[]) => {
            const rows = database.prepare(sql).all(...values);
            return { toArray: () => rows };
          },
        },
      },
    };
    const gadget = new Gadget(context as unknown as DurableObjectState, {} as never);
    expect(await gadget.listInvestigations()).toMatchObject([
      { run_key: "k", status: "completed", mode: null, fix_branch: null, change_url: null },
    ]);
  });
});
