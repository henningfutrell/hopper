// Issue #1349, through the real composition root and the real HTTP server: a sandbox is never a machine. The hopper
// launches no box that joins as one, and it burns each box it launched before, with its home and its sandbox record. The
// container runtime is a double at its port (test/support/fake-container-runtime.ts).
//
// Feature: a sandbox never joins as a machine
//   Scenario: Add machine starts no sandbox box
//   Scenario: at start, each box the hopper launched before is burned, with its home and its record; another hopper's stays
//   Scenario: a box it cannot burn is shown with the reason, until it goes
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerSpec, SandboxRecord } from '../../src/domain/sandboxes.ts';
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

async function boot(runtime: FakeContainerRuntime, dbPath?: string): Promise<{ a: TestApp; session: string; dbPath: string }> {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    path = db.dbPath;
  }
  t = await startTestApp({ dbPath: path, secrets: { HOPPER_MASTER_KEY: KEY }, ...(dbPath ? { plugins: false } : { plugins: PLUGINS }), seams: { containerRuntime: runtime } });
  return { a: t, session: await t.login(), dbPath: path };
}

const spec = (name: string, owner: string): ContainerSpec => ({
  name, image: BOX_IMAGE, network: 'host', volume: `${name}-home`, env: {}, labels: { [BOX_LABEL]: owner, [USER_LABEL]: 'admin' }, limits: { cpus: 1, memoryMb: 1 }, user: 'agent',
});
const record = (name: string): SandboxRecord => ({
  id: `sbx-${name}`, userId: 'admin', name, agent: 'claude', image: BOX_IMAGE, params: { secrets: [], cpus: 1, memoryMb: 1024 }, runtime: 'podman',
  machine: 'local', containerId: '', volume: `${name}-home`, keepHome: true, state: 'ready', createdAt: '2026-10-15T10:00:00.000Z', address: 'http://hopper:4790',
});

interface View { runs: unknown[]; problems: { container: string; reason: string; at: string }[] }
const view = async (a: TestApp, session: string): Promise<View> => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body as View;

/** A hopper that launched boxes before this build: their records kept, their containers and homes there, and another hopper's box. */
async function launchedBefore(runtime: FakeContainerRuntime): Promise<{ a: TestApp; session: string; instanceId: string }> {
  const first = await boot(runtime);
  const instanceId = first.a.app.instance.settings.instanceId();
  for (const name of ['hopper-sandbox-claude', 'hopper-sandbox-asked-302ecc9661e2']) first.a.app.instance.sandboxes.add(record(name));
  await first.a.stop();
  t = undefined;
  runtime.put(spec('hopper-sandbox-claude', instanceId));
  runtime.put(spec('hopper-sandbox-asked-302ecc9661e2', instanceId));
  runtime.put(spec('hopper-sandbox-orphan', instanceId));
  runtime.put(spec('hopper-sandbox-theirs', 'another-hopper'));
  const { a, session } = await boot(runtime, first.dbPath);
  return { a, session, instanceId };
}

describe('a sandbox never joins as a machine', () => {
  it('Add machine starts no sandbox box', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await boot(runtime);
    const r = await a.ui('/ui/api/machines/sandbox', { agent: 'claude' }, { token: session });
    expect(r.status).toBe(404);
    expect(runtime.boxes.size).toBe(0);
    const v = await view(a, session);
    expect(Object.keys(v).sort()).toEqual(['problems', 'runs']);
  });

  it('at start, each box the hopper launched before is burned, with its home and its record; another hopper\'s stays', async () => {
    const runtime = createFakeContainerRuntime();
    const { a, session } = await launchedBefore(runtime);
    await a.app.sandboxes.burnLaunched();
    expect([...runtime.boxes.keys()]).toEqual(['hopper-sandbox-theirs']);
    expect([...runtime.volumes].sort()).toEqual(['hopper-sandbox-theirs-home']);
    expect(a.app.instance.sandboxes.list()).toEqual([]);
    expect((await view(a, session)).problems).toEqual([]);
  });

  it('a box it cannot burn is shown with the reason, until it goes', async () => {
    const runtime = createFakeContainerRuntime();
    runtime.removeFails = 'the runtime refused';
    const { a, session } = await launchedBefore(runtime);
    await a.app.sandboxes.burnLaunched();
    expect((await view(a, session)).problems.map((p) => [p.container, p.reason]).sort()).toEqual([
      ['hopper-sandbox-asked-302ecc9661e2', 'the runtime refused'], ['hopper-sandbox-claude', 'the runtime refused'], ['hopper-sandbox-orphan', 'the runtime refused'],
    ]);
    // Its record stays while its box is there.
    expect(a.app.instance.sandboxes.list().map((r) => r.name).sort()).toEqual(['hopper-sandbox-asked-302ecc9661e2', 'hopper-sandbox-claude']);

    delete runtime.removeFails;
    await a.app.sandboxes.burnLaunched();
    expect((await view(a, session)).problems).toEqual([]);
    expect([...runtime.boxes.keys()]).toEqual(['hopper-sandbox-theirs']);
    expect(a.app.instance.sandboxes.list()).toEqual([]);
  });
});
