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

const setup = () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = new Map<string, unknown>();
  const investigate = vi.fn().mockResolvedValue(undefined);
  const spawnCallable = vi.fn().mockResolvedValue({ investigate, [Symbol.dispose]() {} });
  const subscribe = vi.fn().mockResolvedValue(undefined);
  let gadget: InstanceType<typeof Gadget>;
  const context = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      setAlarm: vi.fn().mockResolvedValue(undefined),
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
    INVESTIGATOR: { spawnCallable },
    CLOUDFLARE_NOTIFICATIONS: { subscribe, getStatus: vi.fn() },
  };
  const restart = () => {
    gadget = new Gadget(context as unknown as DurableObjectState, env);
    return gadget;
  };
  return { gadget: restart(), restart, spawnCallable, investigate, subscribe, storage, context };
};

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
    await fixture.restart().onNotification({ ...notification(), id: "envelope-2" });
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    await fixture.gadget.alarm();
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
    await fixture.gadget.alarm();
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
    await fixture.gadget.alarm();
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
    await fixture.gadget.alarm();
    expect(fixture.spawnCallable).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({ investigationsEnabled: true });
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
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    const dispatch = fixture.gadget.alarm();
    await vi.waitFor(() => expect(fixture.spawnCallable).toHaveBeenCalledTimes(1));
    const next = notification();
    next.data.state_correlation_id = "run-2";
    await fixture.gadget.onNotification(next);
    expect(await fixture.gadget.listInvestigations()).toHaveLength(2);
    allocation.resolve({ investigate: fixture.investigate, [Symbol.dispose]() {} });
    await dispatch;
    await fixture.gadget.alarm();
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
    await fixture.gadget.alarm();
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: "failed" }]);
    await fixture.gadget.retryInvestigation(`${scope.accountId}:run-1`);
    await fixture.gadget.alarm();
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
    const oldDispatch = fixture.gadget.alarm();
    await vi.waitFor(() => expect(fixture.spawnCallable).toHaveBeenCalledTimes(1));
    const replacement = fixture.restart();
    expect(await replacement.listInvestigations()).toMatchObject([{ status: "failed" }]);
    await replacement.retryInvestigation(`${scope.accountId}:run-1`);
    await replacement.alarm();
    allocation.resolve({ investigate: fixture.investigate, [Symbol.dispose]() {} });
    await oldDispatch;
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(await replacement.listInvestigations()).toMatchObject([{ status: "queued" }]);
  });
});
