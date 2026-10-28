// @vitest-environment node
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gadget } from '../files/server.js';

const { restore } = vi.hoisted(() => ({ restore: Symbol('restore') }));
vi.mock('cloudflare:workers', () => ({
  restore,
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  },
  RpcStub: class {
    target: object;
    constructor(target: object) { this.target = target; }
  },
}));

const scope = { accountId: 'a'.repeat(32), workerName: 'checkout-test' };
const notification = () => ({
  id: 'envelope-1', accountId: scope.accountId, alertType: 'workers_observability_real_time_issue',
  data: { state_event: 'ALERT_STATE_EVENT_START', state_correlation_id: 'run-1', issue: {
    id: 'issue-1', services: [{ type: 'SERVICE_TYPE_WORKER', name: scope.workerName }],
  } },
});
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const setup = () => {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const storage = new Map<string, unknown>();
  const investigate = vi.fn().mockResolvedValue(undefined);
  const spawnCallable = vi.fn().mockResolvedValue({ investigate, [Symbol.dispose]() {} });
  const subscribe = vi.fn().mockResolvedValue(undefined);
  let gadget: InstanceType<typeof Gadget>;
  const context = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      sql: { exec: (sql: string, ...values: SQLInputValue[]) => {
        const rows = database.prepare(sql).all(...values);
        return { toArray: () => rows };
      } },
    },
    restore: async (params: object) => Object.assign(Reflect.get(gadget, restore).call(gadget, params).target, { [Symbol.dispose]() {} }),
  };
  const env = { INVESTIGATOR: { spawnCallable }, CLOUDFLARE_NOTIFICATIONS: { subscribe, getStatus: vi.fn() } };
  const restart = () => { gadget = new Gadget(context, env); return gadget; };
  return { gadget: restart(), restart, spawnCallable, investigate, subscribe };
};

describe('Worker issue investigation inbox', () => {
  it('registers one external-policy hook, including concurrent initialization and restart', async () => {
    const fixture = setup();
    await Promise.all([fixture.gadget.initialize(scope), fixture.gadget.initialize(scope)]);
    await fixture.restart().initialize(scope);
    expect(fixture.subscribe).toHaveBeenCalledTimes(1);
    expect(fixture.subscribe).toHaveBeenCalledWith(expect.anything(), {
      alertType: 'workers_observability_real_time_issue', createPolicy: false,
    });
    await expect(fixture.gadget.initialize({ ...scope, workerName: 'other-worker' })).rejects.toThrow('different Worker');
  });

  it('deduplicates a logical run across envelopes and a process restart', async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.restart().onNotification({ ...notification(), id: 'envelope-2' });
    expect(fixture.spawnCallable).toHaveBeenCalledTimes(1);
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ issue_id: 'issue-1', status: 'queued' }]);
  });

  it('ignores other accounts, other Workers, resolved events, and malformed service evidence', async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.onNotification({ ...notification(), accountId: 'b'.repeat(32) });
    const other = notification(); other.data.issue.services[0]!.name = 'other-worker';
    await fixture.gadget.onNotification(other);
    const resolved = notification(); resolved.data.state_event = 'ALERT_STATE_EVENT_END';
    await fixture.gadget.onNotification(resolved);
    await fixture.gadget.onNotification({ ...notification(), data: { issue: { services: {} } } });
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous dispatch visible and never blindly sends it twice', async () => {
    const fixture = setup();
    fixture.investigate.mockRejectedValue(new Error('Connection lost after dispatch'));
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    await fixture.restart().onNotification({ ...notification(), id: 'retry-envelope' });
    expect(fixture.investigate).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: 'delivery_unknown' }]);
  });

  it('records findings through the task and does not overwrite completed reports with queued state', async () => {
    const fixture = setup();
    fixture.investigate.mockImplementation(async (task: { complete(report: string): Promise<void> }) => task.complete('Telemetry confirms a missing coupon TypeError. No source or project tests were accessed.'));
    await fixture.gadget.initialize(scope);
    await fixture.gadget.enableInvestigations();
    await fixture.gadget.onNotification(notification());
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: 'completed', report: expect.stringContaining('No source or project tests') }]);
  });

  it('stores notifications without invoking a model until explicit opt-in, with no backfill', async () => {
    const fixture = setup();
    await fixture.gadget.initialize(scope);
    await fixture.gadget.onNotification(notification());
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    expect(await fixture.gadget.listInvestigations()).toMatchObject([{ status: 'received' }]);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({ ...scope, investigationsEnabled: false });
    await fixture.gadget.enableInvestigations();
    await fixture.restart().onNotification(notification());
    expect(fixture.spawnCallable).not.toHaveBeenCalled();
    const next = notification(); next.data.state_correlation_id = 'run-2';
    await fixture.gadget.onNotification(next);
    expect(fixture.spawnCallable).toHaveBeenCalledTimes(1);
    expect(await fixture.gadget.getSetupStatus()).toMatchObject({ investigationsEnabled: true });
  });
});
