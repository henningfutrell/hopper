// Issues #603, #708, through the real composition root and the real HTTP server: the sandbox module owns the life of
// the boxes the hopper starts, from their records. The container runtime is a double at its port
// (test/support/fake-container-runtime.ts); the real runtimes behind it are test/adapters/podman-runtime.test.ts,
// docker-runtime.test.ts and podman-sandbox.test.ts. A box "started" here joins with the join line the hopper gave it,
// as its client does (design.md "Sandbox boxes the hopper launches").
//
// Feature: the hopper owns the life of its sandbox boxes
//   Scenario: adding a sandbox box starts its container and records it; it is ready once it joins
//   Scenario: a box of a template runs the template's image, only once that image is approved
//   Scenario: a launch fills in the template's defaults, takes parameters within its max, and records them
//   Scenario: parameters outside what the template allows are refused, and nothing starts
//   Scenario: removing the machine removes the box and its record; its home volume stays
//   Scenario: a template that does not keep the home removes the volume with the box
//   Scenario: a box past its time limit is stopped and removed; its home volume stays
//   Scenario: a box that has not joined yet is kept while its join code is live
//   Scenario: at start, a box of its own with no record goes, unless a machine names it; another hopper's stays
//   Scenario: a box it cannot remove is shown with the reason, until it goes
//   Scenario: a box that does not start leaves nothing: no container, no volume, no record
//   Scenario: an image that runs as root does not start
//   Scenario: the line Add machine shows carries the same sandbox flags
//   Scenario: without a runtime, or with a rootful one, Add machine says why and starts nothing
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { runFlags } from '../../src/sandbox/flags.ts';
import { DEFAULT_LIMITS } from '../../src/sandbox/params.ts';
import { BOX_LABEL, USER_LABEL } from '../../src/sandbox/service.ts';
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
const BOX_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

async function boot(runtime: FakeContainerRuntime | undefined, dbPath?: string): Promise<{ a: TestApp; session: string; dbPath: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  t = await startTestApp({ dbPath: path, secrets: { HOPPER_MASTER_KEY: KEY }, ...(dbPath ? { plugins: false } : { plugins: PLUGINS }), seams: runtime ? { containerRuntime: runtime } : {} });
  return { a: t, session: await t.login(), dbPath: path };
}

type Machine = { name: string; options: Record<string, unknown> };
interface Box {
  name: string; state: string; agent: string; template?: { name: string; version: string }; image: string; runtime: string;
  params: { secrets: string[]; cpus: number; memoryMb: number; ttlMinutes?: number; profile?: string };
  createdAt: string; expiresAt?: string; address: string;
}
interface View { launch: { available: boolean; problem?: string; runtime?: string }; line: string; boxes: Box[]; problems: { container: string; reason: string; at: string }[] }
const machines = async (a: TestApp): Promise<{ version: string; machines: Machine[] }> => (await a.api('GET', '/api/machines/config')).body;
const view = async (a: TestApp, session: string): Promise<View> => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body as View;
const launch = (a: TestApp, session: string, body: unknown) => a.ui<{ container: string; error: string }>('/ui/api/machines/sandbox', body, { token: session });

/** The box's client: joins with the line the hopper put in the box's environment. */
async function boxJoins(a: TestApp, runtime: FakeContainerRuntime, name: string): Promise<void> {
  const { HOPPER_JOIN: line, HOPPER_CLIENT_NAME: client } = runtime.boxes.get(name)!.spec.env;
  const dir = mkdtempSync(join(tmpdir(), 'hopper-box-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // The line names the hopper as the box reaches it; here that is the test hopper's own loopback URL.
  expect(line?.startsWith(`${a.url}#`)).toBe(true);
  await joinHopper({ line: line!, name: client!, dir });
}

/** Two checks: a box is removed only when it is found with no machine twice in a row. */
async function reconcile(a: TestApp, at?: Date): Promise<void> {
  await a.app.sandboxes.reconcile(at);
  await a.app.sandboxes.reconcile(at);
}

async function kubeTemplate(a: TestApp, session: string, limits?: unknown): Promise<void> {
  await a.ui('/ui/api/vault', { action: 'set', name: 'KUBE_TOKEN', value: 'KUBE_TOKEN-value-0123456789' }, { token: session });
  await a.ui('/ui/api/vault', { action: 'set', name: 'AWS_KEY', value: 'AWS_KEY-value-0123456789abc' }, { token: session });
  const saved = await a.ui('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN', 'AWS_KEY'], ...(limits ? { limits } : {}) }, { token: session });
  expect(saved.status).toBe(200);
}

describe('sandbox boxes the hopper starts', () => {
  it('adding a sandbox box starts its container and records it; it is ready once it joins', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    expect((await view(a, session)).launch).toEqual({ available: true, runtime: 'podman' });

    const r = await launch(a, session, { agent: 'claude' });
    expect(r.status).toBe(200);
    expect(r.body.container).toBe('hopper-sandbox-claude');
    const box = runtime.boxes.get('hopper-sandbox-claude')!;
    expect(box.state).toBe('running');
    expect(box.spec).toMatchObject({
      image: BOX_IMAGE, volume: 'hopper-sandbox-claude-home', network: 'host', user: 'agent',
      limits: { cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default },
      labels: { [BOX_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin' },
      env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-claude' },
    });
    expect((await view(a, session)).boxes).toEqual([expect.objectContaining({
      name: 'hopper-sandbox-claude', state: 'starting', agent: 'claude', image: BOX_IMAGE, runtime: 'podman', address: a.url,
      params: { secrets: [], cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default },
    })]);
    expect((await view(a, session)).boxes[0]!.expiresAt).toBeUndefined();

    await boxJoins(a, runtime, 'hopper-sandbox-claude');
    expect((await machines(a)).machines.find((m) => m.name === 'hopper-sandbox-claude')!.options).toMatchObject({ container: 'hopper-sandbox-claude' });
    // A machine names it: it reported back, so it is ready, and it stays.
    await reconcile(a);
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(true);
    expect((await view(a, session)).boxes.map((b) => b.state)).toEqual(['ready']);

    // A second box takes a free name, past a container someone else made.
    runtime.put({ name: 'hopper-sandbox-claude-2', image: 'x', network: 'host', volume: 'x-home', env: {}, labels: {}, limits: { cpus: 1, memoryMb: 1 }, user: 'x' });
    expect((await launch(a, session, {})).body.container).toBe('hopper-sandbox-claude-3');
  });

  it('a box of a template runs the template\'s image, only once that image is approved', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kubeTemplate(a, session);
    expect((await launch(a, session, { template: 'nope' })).status).toBe(404);
    const refused = await launch(a, session, { template: 'kube' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/not approved/);
    expect(runtime.boxes.size).toBe(0);

    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    expect((await launch(a, session, { template: 'kube' })).body.container).toBe('hopper-sandbox-kube');
    expect(runtime.boxes.get('hopper-sandbox-kube')!.spec.image).toBe('example.org/kube-box:1');
    await boxJoins(a, runtime, 'hopper-sandbox-kube');
    expect((await machines(a)).machines.find((m) => m.name === 'hopper-sandbox-kube')!.options).toMatchObject({ template: 'kube', container: 'hopper-sandbox-kube' });
  });

  it('a launch fills in the template\'s defaults, takes parameters within its max, and records them', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kubeTemplate(a, session, { cpus: { default: 1, max: 2 }, memoryMb: { default: 1024, max: 4096 }, ttlMinutes: { default: 60, max: 480 } });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });

    expect((await launch(a, session, { template: 'kube' })).status).toBe(200);
    expect(runtime.boxes.get('hopper-sandbox-kube')!.spec.limits).toEqual({ cpus: 1, memoryMb: 1024 });
    const first = (await view(a, session)).boxes[0]!;
    expect(first.params).toEqual({ secrets: ['KUBE_TOKEN', 'AWS_KEY'], cpus: 1, memoryMb: 1024, ttlMinutes: 60 });
    expect(first.template).toEqual({ name: 'kube', version: expect.any(String) });
    expect(Date.parse(first.expiresAt!) - Date.parse(first.createdAt)).toBe(60 * 60_000);

    const r = await launch(a, session, { template: 'kube', params: { secrets: ['KUBE_TOKEN'], cpus: 2, memoryMb: 4096, ttlMinutes: 480 } });
    expect(r.status).toBe(200);
    expect(runtime.boxes.get('hopper-sandbox-kube-2')!.spec.limits).toEqual({ cpus: 2, memoryMb: 4096 });
    expect((await view(a, session)).boxes.find((b) => b.name === 'hopper-sandbox-kube-2')!.params).toEqual({ secrets: ['KUBE_TOKEN'], cpus: 2, memoryMb: 4096, ttlMinutes: 480 });
  });

  it('parameters outside what the template allows are refused, and nothing starts', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kubeTemplate(a, session, { cpus: { default: 1, max: 2 }, memoryMb: { default: 1024, max: 4096 }, ttlMinutes: { default: 60, max: 480 } });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });

    for (const [params, error] of [
      [{ cpus: 3 }, 'cpus 3 is more than the template kube allows: at most 2'],
      [{ memoryMb: 8192 }, 'memoryMb 8192 is more than the template kube allows: at most 4096'],
      [{ ttlMinutes: 600 }, 'ttlMinutes 600 is more than the template kube allows: at most 480'],
      [{ secrets: ['GH_TOKEN'] }, 'the template kube does not give GH_TOKEN: it gives KUBE_TOKEN, AWS_KEY'],
    ] as const) {
      const r = await launch(a, session, { template: 'kube', params });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(error);
    }
    expect((await launch(a, session, { params: { cpus: DEFAULT_LIMITS.cpus.max + 1 } })).status).toBe(400);
    const bad = await a.ui<{ error: string }>('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: [], limits: { cpus: { default: 4, max: 2 } } }, { token: session });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('cpus: the default 4 is more than the max 2');
    expect(runtime.boxes.size).toBe(0);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('removing the machine removes the box and its record; its home volume stays', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await launch(a, session, {});
    await boxJoins(a, runtime, 'hopper-sandbox-claude');

    const { version } = await machines(a);
    const removed = await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'hopper-sandbox-claude', version }, { token: session });
    expect(removed.status).toBe(200);
    await reconcile(a);
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(false);
    expect(runtime.volumes.has('hopper-sandbox-claude-home')).toBe(true);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('a template that does not keep the home removes the volume with the box', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await kubeTemplate(a, session, { keepHome: false });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    await launch(a, session, { template: 'kube' });
    // Never joined, and a day on its join code has expired: no machine names it, and no code waits for it.
    await reconcile(a, new Date(Date.now() + 86_400_000));
    expect(runtime.boxes.has('hopper-sandbox-kube')).toBe(false);
    expect(runtime.volumes.has('hopper-sandbox-kube-home')).toBe(false);
  });

  it('a box past its time limit is stopped and removed; its home volume stays', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await launch(a, session, { params: { ttlMinutes: 30 } });
    await boxJoins(a, runtime, 'hopper-sandbox-claude');
    await reconcile(a, new Date(Date.now() + 29 * 60_000));
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(true);

    await a.app.sandboxes.reconcile(new Date(Date.now() + 31 * 60_000));
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(false);
    expect(runtime.volumes.has('hopper-sandbox-claude-home')).toBe(true);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('a box that has not joined yet is kept while its join code is live', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await launch(a, session, {});
    await reconcile(a);
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(true);
    expect((await view(a, session)).boxes.map((b) => b.state)).toEqual(['starting']);
  });

  it('at start, a box of its own with no record goes, unless a machine names it; another hopper\'s stays', async () => {
    const runtime = createFakeContainerRuntime();
    const first = await boot(runtime);
    // A box from before the records (issue #603): labelled as this hopper's, joined, and named by its machine.
    const instanceId = first.a.app.instance.settings.instanceId();
    const spec = (name: string, owner: string) => ({ name, image: BOX_IMAGE, network: 'host', volume: `${name}-home`, env: {}, labels: { [BOX_LABEL]: owner, [USER_LABEL]: 'admin' }, limits: { cpus: 1, memoryMb: 1 }, user: 'agent' });
    await first.a.ui('/ui/api/machines/sandbox', {}, { token: first.session });
    await boxJoins(first.a, runtime, 'hopper-sandbox-claude');
    await first.a.stop();
    t = undefined;

    // While the hopper was down: a box of its own that no machine names and no record holds, and another hopper's box.
    runtime.put(spec('hopper-sandbox-orphan', instanceId));
    runtime.put(spec('hopper-sandbox-theirs', 'another-hopper'));
    runtime.put(spec('hopper-sandbox-legacy', instanceId));

    const { a, session } = await boot(runtime, first.dbPath);
    expect(a.app.instance.settings.instanceId()).toBe(instanceId);
    await reconcile(a);
    expect([...runtime.boxes.keys()].sort()).toEqual(['hopper-sandbox-claude', 'hopper-sandbox-theirs']);
    // An orphan's home stays too: it may hold an agent's sign-in.
    expect(runtime.volumes.has('hopper-sandbox-orphan-home')).toBe(true);
    expect((await view(a, session)).boxes.map((b) => b.name)).toEqual(['hopper-sandbox-claude']);
  });

  it('a box of its own with no record that a machine names is taken on as a record', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await launch(a, session, {});
    await boxJoins(a, runtime, 'hopper-sandbox-claude');
    // As a box from before the records: the container and its machine, no record.
    a.app.instance.sandboxes.remove(a.app.instance.sandboxes.list()[0]!.id);
    await reconcile(a);
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(true);
    expect((await view(a, session)).boxes).toEqual([expect.objectContaining({ name: 'hopper-sandbox-claude', state: 'ready', runtime: 'podman' })]);
  });

  it('a box it cannot remove is shown with the reason, until it goes', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    await launch(a, session, {});
    await boxJoins(a, runtime, 'hopper-sandbox-claude');
    const { version } = await machines(a);
    await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'hopper-sandbox-claude', version }, { token: session });

    runtime.removeFails = 'podman refused to remove the box hopper-sandbox-claude (500): device or resource busy';
    await reconcile(a);
    expect((await view(a, session)).problems).toEqual([
      { container: 'hopper-sandbox-claude', reason: runtime.removeFails, at: expect.any(String) },
    ]);

    runtime.removeFails = undefined;
    await reconcile(a);
    expect(runtime.boxes.has('hopper-sandbox-claude')).toBe(false);
    expect((await view(a, session)).problems).toEqual([]);
  });

  it('a box that does not start leaves nothing: no container, no volume, no record', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    runtime.createFails = 'podman could not pull ghcr.io/henningfutrell/hopper:box-claude: no such host';
    const r = await launch(a, session, {});
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('no such host');
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('an image that runs as root does not start', async () => {
    const runtime = createFakeContainerRuntime();
    runtime.imageUsers.set(BOX_IMAGE, '');
    const { a, session } = await boot(runtime);
    const r = await launch(a, session, {});
    expect(r.status).toBe(502);
    expect(r.body.error).toContain(`the image ${BOX_IMAGE} runs as root`);
    expect(runtime.boxes.size).toBe(0);
  });

  it('the line Add machine shows carries the same sandbox flags', async () => {
    const { a, session } = await boot(createFakeContainerRuntime());
    expect((await view(a, session)).line).toBe(runFlags({ cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default }).join(' '));
  });

  it('without a runtime, Add machine says why and starts nothing', async () => {
    const { a, session } = await boot(undefined);
    const v = await view(a, session);
    expect(v.launch.available).toBe(false);
    expect(v.launch.problem).toMatch(/HOPPER_PODMAN_SOCKET/);
    const r = await launch(a, session, {});
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/HOPPER_PODMAN_SOCKET/);
  });

  it('rootful or unreachable Podman starts nothing, and says why', async () => {
    const runtime = createFakeContainerRuntime();
    runtime.down = 'podman at /run/podman/podman.sock is not rootless: the hopper launches sandbox boxes only through a rootless runtime';
    const { a, session } = await boot(runtime);
    expect((await view(a, session)).launch).toEqual({ available: false, problem: runtime.down, runtime: 'podman' });
    expect((await launch(a, session, {})).status).toBe(502);
    expect(runtime.boxes.size).toBe(0);
  });
});
