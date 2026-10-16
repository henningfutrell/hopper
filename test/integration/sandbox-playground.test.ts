// Issue #1410, through the real composition root and the real HTTP server: the sandbox playground starts many sandboxes
// in one request, lists them and destroys them. The container runtime is a double at its port
// (test/support/fake-container-runtime.ts); the playground's own rules are test/sandbox/playground.test.ts.
//
// Feature: the sandbox playground over the API
//   Scenario: a create starts as many as the limits allow, and refuses the rest naming the limit; none fits: 429
//   Scenario: playground sandboxes never appear in the machines list, and take no lane
//   Scenario: destroy-all removes every container and home volume
//   Scenario: a size over the hopper's max is refused with 400; no such template: 404
//   Scenario: a hopper restart removes every playground sandbox it left
import { afterEach, describe, expect, it } from 'vitest';
import { PLAYGROUND_LABEL } from '../../src/sandbox/playground.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const PLUGINS = { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } };
const LIMITS = { HOPPER_SANDBOX_MAX_CONCURRENT: '4', HOPPER_SANDBOX_MAX_PER_USER: '4', HOPPER_SANDBOX_MAX_CPUS: '2' };

async function boot(runtime: FakeContainerRuntime, dbPath?: string): Promise<{ a: TestApp; session: string; dbPath: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  t = await startTestApp({ dbPath: path, env: LIMITS, secrets: { HOPPER_MASTER_KEY: KEY }, ...(dbPath ? { plugins: false } : { plugins: PLUGINS }), seams: { containerRuntime: runtime } });
  return { a: t, session: await t.login(), dbPath: path };
}

interface Sandbox { id: string; name: string; state: string; size: { cpus: number; memoryMb: number; ttlMinutes: number } }
interface View { problem?: string; limits: { maxConcurrent: number }; running: { all: number; yours: number }; sandboxes: Sandbox[] }
const view = async (a: TestApp, session: string): Promise<View> => (await a.api('GET', '/api/sandbox-playground', undefined, { 'x-hopper-session': session })).body as View;
const create = (a: TestApp, session: string, body: unknown) => a.ui<{ started: Sandbox[]; refused?: { count: number; limit: string; setting: string }; error?: string; limit?: string }>('/ui/api/sandbox-playground', body, { token: session });

async function running(a: TestApp, session: string, n: number): Promise<View> {
  for (let i = 0; i < 200; i++) {
    const v = await view(a, session);
    if (v.sandboxes.filter((s) => s.state === 'running').length === n) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`not ${n} running`);
}

describe('the sandbox playground over the API', () => {
  it('starts as many as the limits allow, refuses the rest naming the limit, and destroys them all', async () => {
    const rt = createFakeContainerRuntime();
    const { a, session } = await boot(rt);
    const r = await create(a, session, { count: 6, cpus: 1.5, ttlMinutes: 30 });
    expect(r.status).toBe(200);
    expect(r.body.started).toHaveLength(4);
    expect(r.body.refused).toMatchObject({ count: 2, limit: 'maxConcurrent', setting: 'HOPPER_SANDBOX_MAX_CONCURRENT' });
    const v = await running(a, session, 4);
    expect(v.running).toEqual({ all: 4, yours: 4 });
    expect(v.limits.maxConcurrent).toBe(4);
    expect(v.sandboxes[0]!.size).toMatchObject({ cpus: 1.5, ttlMinutes: 30 });
    expect([...rt.boxes.values()].filter((b) => b.spec.labels[PLAYGROUND_LABEL])).toHaveLength(4);

    const full = await create(a, session, { count: 1 });
    expect(full.status).toBe(429);
    expect(full.body).toMatchObject({ limit: 'maxConcurrent', setting: 'HOPPER_SANDBOX_MAX_CONCURRENT' });
    expect(full.body.error).toContain('at most 4');

    // No playground sandbox is a machine: none is in the machines list or its config, and none has a lane.
    const machines = (await a.api('GET', '/api/machines', undefined, { 'x-hopper-session': session })).body as { machines: { name: string; lanes: unknown[] }[] };
    expect(machines.machines.filter((m) => m.name.startsWith('hopper-playground-'))).toEqual([]);
    const config = (await a.api('GET', '/api/machines/config')).body as { machines: { name: string }[] };
    expect(config.machines).toEqual([]);

    const gone = await a.ui<{ destroyed: number }>('/ui/api/sandbox-playground/destroy', { all: true }, { token: session });
    expect(gone.body).toEqual({ destroyed: 4, problems: [] });
    expect(rt.boxes.size).toBe(0);
    expect(rt.volumes.size).toBe(0);
    expect((await view(a, session)).sandboxes).toEqual([]);
  });

  it('refuses a size over the hopper\'s max with 400, and a template it does not have with 404', async () => {
    const rt = createFakeContainerRuntime();
    const { a, session } = await boot(rt);
    const big = await create(a, session, { count: 2, cpus: 3 });
    expect(big.status).toBe(400);
    expect(big.body.error).toContain('HOPPER_SANDBOX_MAX_CPUS');
    expect((await create(a, session, { template: 'nope' })).status).toBe(404);
    expect(rt.boxes.size).toBe(0);
  });

  it('a hopper restart removes every playground sandbox it left', async () => {
    const rt = createFakeContainerRuntime();
    const { a, session, dbPath } = await boot(rt);
    await create(a, session, { count: 3 });
    await running(a, session, 3);
    await a.stop();
    t = undefined;
    expect(rt.boxes.size).toBe(3);

    const again = await boot(rt, dbPath);
    for (let i = 0; i < 200 && rt.boxes.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(rt.boxes.size).toBe(0);
    expect(rt.volumes.size).toBe(0);
    expect((await view(again.a, again.session)).sandboxes).toEqual([]);
  });
});
