// Issue #603, through the real composition root and the real HTTP server: the hopper starts, stops and removes the
// sandbox boxes itself. The sandbox engine is a double at its port (test/support/fake-sandbox-engine.ts); the real
// rootless Podman behind it is test/adapters/podman-sandbox.test.ts. A box "started" here joins with the join line
// the hopper gave it, as its client does (design.md "Sandbox boxes the hopper launches").
//
// Feature: the hopper owns the life of its sandbox boxes
//   Scenario: adding a sandbox box starts its container, which joins as the machine
//     When an admin adds a sandbox box of the agent claude
//     Then the hopper starts the container hopper-sandbox-claude from the published box image, labelled as its own
//     And the box joins with the line it was given, as the machine hopper-sandbox-claude that names its container
//   Scenario: a box of a template runs the template's image, only once that image is approved
//   Scenario: removing the machine stops and removes its container and its volume
//   Scenario: a box that has not joined yet is kept while its join code is live
//   Scenario: at start, the hopper removes a box of its own that no machine names, and leaves another hopper's
//   Scenario: a box it cannot remove is shown with the reason, until it goes
//   Scenario: without a Podman socket, Add machine says why and starts nothing
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { BOX_LABEL, USER_LABEL } from '../../src/sandboxes/service.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeSandboxEngine, type FakeSandboxEngine } from '../support/fake-sandbox-engine.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const PLUGINS = { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } };

async function boot(engine: FakeSandboxEngine | undefined, dbPath?: string): Promise<{ a: TestApp; session: string; dbPath: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  t = await startTestApp({ dbPath: path, secrets: { HOPPER_TOKEN_KEY: KEY }, ...(dbPath ? { plugins: false } : { plugins: PLUGINS }), seams: engine ? { sandboxEngine: engine } : {} });
  return { a: t, session: await t.login(), dbPath: path };
}

type Machine = { name: string; options: Record<string, unknown> };
const machines = async (a: TestApp): Promise<{ version: string; machines: Machine[] }> => (await a.api('GET', '/api/machines/config')).body;
const sandboxes = async (a: TestApp, session: string) => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body as {
  launch: { available: boolean; problem?: string }; problems: { container: string; reason: string; at: string }[];
};

/** The box's client: joins with the line the hopper put in the box's environment. */
async function boxJoins(a: TestApp, engine: FakeSandboxEngine, name: string): Promise<void> {
  const { HOPPER_JOIN: line, HOPPER_CLIENT_NAME: client } = engine.boxes.get(name)!.env;
  const dir = mkdtempSync(join(tmpdir(), 'hopper-box-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // The line names the hopper as the box reaches it; here that is the test hopper's own loopback URL.
  expect(line?.startsWith(`${a.url}#`)).toBe(true);
  await joinHopper({ line: line!, name: client!, dir });
}

/** Two checks: a box is removed only when it is found with no machine twice in a row. */
async function reconcile(a: TestApp): Promise<void> {
  await a.app.sandboxes.reconcile();
  await a.app.sandboxes.reconcile();
}

describe('sandbox boxes the hopper starts', () => {
  it('adding a sandbox box starts its container, which joins as the machine that names it', async () => {
    const engine = createFakeSandboxEngine();
    const { a, session } = await boot(engine);
    expect((await sandboxes(a, session)).launch).toEqual({ available: true });

    const r = await a.ui<{ container: string }>('/ui/api/machines/sandbox', { agent: 'claude' }, { token: session });
    expect(r.status).toBe(200);
    expect(r.body.container).toBe('hopper-sandbox-claude');
    const box = engine.boxes.get('hopper-sandbox-claude')!;
    expect(box).toMatchObject({
      image: 'ghcr.io/henningfutrell/hopper:box-claude', volume: 'hopper-sandbox-claude-home', network: 'host',
      labels: { [BOX_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin' },
      env: { HOPPER_CLIENT_NAME: 'hopper-sandbox-claude' },
    });

    await boxJoins(a, engine, 'hopper-sandbox-claude');
    expect((await machines(a)).machines.find((m) => m.name === 'hopper-sandbox-claude')!.options).toMatchObject({ container: 'hopper-sandbox-claude' });
    // A machine names it: it stays.
    await reconcile(a);
    expect(engine.boxes.has('hopper-sandbox-claude')).toBe(true);

    // A second box takes a free name.
    expect((await a.ui<{ container: string }>('/ui/api/machines/sandbox', {}, { token: session })).body.container).toBe('hopper-sandbox-claude-2');
  });

  it('a box of a template runs the template\'s image, only once that image is approved', async () => {
    const engine = createFakeSandboxEngine();
    const { a, session } = await boot(engine);
    await a.ui('/ui/api/vault', { action: 'set', name: 'KUBE_TOKEN', value: 'KUBE_TOKEN-value-0123456789' }, { token: session });
    await a.ui('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: ['KUBE_TOKEN'] }, { token: session });
    expect((await a.ui('/ui/api/machines/sandbox', { template: 'nope' }, { token: session })).status).toBe(404);
    const refused = await a.ui<{ error: string }>('/ui/api/machines/sandbox', { template: 'kube' }, { token: session });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/not approved/);
    expect(engine.boxes.size).toBe(0);

    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    expect((await a.ui<{ container: string }>('/ui/api/machines/sandbox', { template: 'kube' }, { token: session })).body.container).toBe('hopper-sandbox-kube');
    expect(engine.boxes.get('hopper-sandbox-kube')!.image).toBe('example.org/kube-box:1');
    await boxJoins(a, engine, 'hopper-sandbox-kube');
    expect((await machines(a)).machines.find((m) => m.name === 'hopper-sandbox-kube')!.options).toMatchObject({ template: 'kube', container: 'hopper-sandbox-kube' });
  });

  it('removing the machine stops and removes its container and its volume', async () => {
    const engine = createFakeSandboxEngine();
    const { a, session } = await boot(engine);
    await a.ui('/ui/api/machines/sandbox', {}, { token: session });
    await boxJoins(a, engine, 'hopper-sandbox-claude');

    const { version } = await machines(a);
    const removed = await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'hopper-sandbox-claude', version }, { token: session });
    expect(removed.status).toBe(200);
    await reconcile(a);
    expect(engine.boxes.has('hopper-sandbox-claude')).toBe(false);
    expect(engine.volumes.has('hopper-sandbox-claude-home')).toBe(false);
  });

  it('a box that has not joined yet is kept while its join code is live', async () => {
    const engine = createFakeSandboxEngine();
    const { a, session } = await boot(engine);
    await a.ui('/ui/api/machines/sandbox', {}, { token: session });
    await reconcile(a);
    expect(engine.boxes.has('hopper-sandbox-claude')).toBe(true);
  });

  it('at start, the hopper removes a box of its own that no machine names, and leaves another hopper\'s', async () => {
    const engine = createFakeSandboxEngine();
    const first = await boot(engine);
    await first.a.ui('/ui/api/machines/sandbox', {}, { token: first.session });
    await boxJoins(first.a, engine, 'hopper-sandbox-claude');
    const instanceId = first.a.app.instance.settings.instanceId();
    await first.a.stop();
    t = undefined;

    // While the hopper was down: a box of its own that no machine names, and another hopper's box.
    const spec = (name: string, owner: string) => ({ name, image: 'ghcr.io/henningfutrell/hopper:box-claude', network: 'host', volume: `${name}-home`, env: {}, labels: { [BOX_LABEL]: owner, [USER_LABEL]: 'admin' } });
    await engine.launch(spec('hopper-sandbox-orphan', instanceId));
    await engine.launch(spec('hopper-sandbox-theirs', 'another-hopper'));

    const { a } = await boot(engine, first.dbPath);
    expect(a.app.instance.settings.instanceId()).toBe(instanceId);
    await reconcile(a);
    expect([...engine.boxes.keys()].sort()).toEqual(['hopper-sandbox-claude', 'hopper-sandbox-theirs']);
    expect(engine.volumes.has('hopper-sandbox-orphan-home')).toBe(false);
  });

  it('a box it cannot remove is shown with the reason, until it goes', async () => {
    const engine = createFakeSandboxEngine();
    const { a, session } = await boot(engine);
    await a.ui('/ui/api/machines/sandbox', {}, { token: session });
    await boxJoins(a, engine, 'hopper-sandbox-claude');
    const { version } = await machines(a);
    await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'hopper-sandbox-claude', version }, { token: session });

    engine.removeFails = 'podman refused to remove the box hopper-sandbox-claude (500): device or resource busy';
    await reconcile(a);
    expect((await sandboxes(a, session)).problems).toEqual([
      { container: 'hopper-sandbox-claude', reason: engine.removeFails, at: expect.any(String) },
    ]);

    engine.removeFails = undefined;
    await reconcile(a);
    expect(engine.boxes.has('hopper-sandbox-claude')).toBe(false);
    expect((await sandboxes(a, session)).problems).toEqual([]);
  });

  it('a box that does not start is removed again, and the reason is the answer', async () => {
    const engine = createFakeSandboxEngine();
    const { a, session } = await boot(engine);
    engine.launchFails = 'podman could not pull ghcr.io/henningfutrell/hopper:box-claude: no such host';
    const r = await a.ui<{ error: string }>('/ui/api/machines/sandbox', {}, { token: session });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('no such host');
    expect(engine.boxes.size).toBe(0);
    expect(engine.volumes.size).toBe(0);
  });

  it('without a Podman socket, Add machine says why and starts nothing', async () => {
    const { a, session } = await boot(undefined);
    const view = await sandboxes(a, session);
    expect(view.launch.available).toBe(false);
    expect(view.launch.problem).toMatch(/HOPPER_PODMAN_SOCKET/);
    const r = await a.ui<{ error: string }>('/ui/api/machines/sandbox', {}, { token: session });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/HOPPER_PODMAN_SOCKET/);
  });

  it('rootful or unreachable Podman starts nothing, and says why', async () => {
    const engine = createFakeSandboxEngine();
    engine.down = 'podman at /run/podman/podman.sock is not rootless: the hopper launches sandbox boxes only through rootless Podman';
    const { a, session } = await boot(engine);
    expect((await sandboxes(a, session)).launch).toEqual({ available: false, problem: engine.down });
    expect((await a.ui('/ui/api/machines/sandbox', {}, { token: session })).status).toBe(502);
    expect(engine.boxes.size).toBe(0);
  });
});
