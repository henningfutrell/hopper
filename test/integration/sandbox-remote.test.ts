// Issue #708, through the real composition root, the real HTTP server and a real client dialled in: the hopper starts
// a sandbox box on an attached machine, through that machine's own Podman, its calls carried by the machine's client
// (the remote runtime). The machine's Podman is a libpod double (test/support/fake-libpod.ts); the hopper's own
// runtime a double at its port, which a box on a machine never touches.
//
// Feature: sandbox boxes on an attached machine
//   Scenario: a box launched on a client target runs in that machine's Podman, dialling the hopper where the machine does
//   Scenario: a machine that is not a client target, or not dialled in, is refused, and nothing starts
//   Scenario: the box on the machine is ready once it joins, and goes when its time limit passes
//   Scenario: while the machine is away its boxes are kept; once it dials in again they are checked
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startLinkedClient } from '../../src/client/main.ts';
import { joinHopper } from '../../src/client/join.ts';
import type { Client } from '../../src/client/server.ts';
import { BOX_LABEL, SANDBOX_LABEL, USER_LABEL } from '../../src/sandbox/service.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { createFakeLibpod, type FakeLibpod } from '../support/fake-libpod.ts';
import { startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
let api: FakeRuntimeApi | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  await api?.close();
  api = undefined;
  for (const c of cleanups.splice(0)) c();
});

const PLUGINS = { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } };
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hopper-machine-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

interface Box { name: string; state: string; runtime: string; machine: string; address: string; expiresAt?: string }
interface Setup { a: TestApp; session: string; local: FakeContainerRuntime; libpod: FakeLibpod; studio: string; startStudio(): void }

/** A hopper, and a machine `studio` joined and dialled in, its client carrying runtime calls to its own Podman. */
async function boot(): Promise<Setup> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const local = createFakeContainerRuntime();
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: PLUGINS, seams: { containerRuntime: local } });
  const session = await t.login();
  const libpod = createFakeLibpod();
  api = await startFakeRuntimeApi(libpod.handlers);
  const studio = dir();
  const code = (await t.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
  await joinHopper({ line: `${t.url}#${code}`, name: 'studio', dir: studio });
  const socket = api.socket;
  const startStudio = (): void => {
    clients.push(startLinkedClient({ dir: studio, herdrBin: '/bin/false', session: 'hopper', installDir: testInstallDir(), backoffMs: [50], runtimeSockets: () => ({ podman: socket }) }));
  };
  startStudio();
  await online(t, 'studio');
  return { a: t, session, local, libpod, studio, startStudio };
}

const online = (a: TestApp, name: string) => waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
const view = async (a: TestApp, session: string): Promise<{ boxes: Box[] }> => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body;
const launch = (a: TestApp, session: string, body: unknown) => a.ui<{ container: string; error: string }>('/ui/api/machines/sandbox', body, { token: session });
const onStudio = (libpod: FakeLibpod, name: string) => [...libpod.containers.values()].find((c) => c.name === name);

describe('sandbox boxes on an attached machine', () => {
  it('a box launched on a client target runs in that machine\'s Podman, dialling the hopper where the machine does', async () => {
    const { a, session, local, libpod } = await boot();
    const r = await launch(a, session, { machine: 'studio' });
    expect(r.status).toBe(200);
    expect(r.body.container).toBe('hopper-sandbox-claude');
    expect(local.boxes.size).toBe(0);

    const box = onStudio(libpod, 'hopper-sandbox-claude')!;
    expect(box.state).toBe('running');
    const record = a.app.instance.sandboxes.list()[0]!;
    expect(box.labels).toEqual({ [BOX_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin', [SANDBOX_LABEL]: record.id });
    // The sandbox flags, on the machine too; on the machine's network, it reaches the hopper as the machine's client does.
    expect(box.body).toMatchObject({ cap_drop: ['ALL'], no_new_privileges: true, read_only_filesystem: true, user: 'agent', netns: { nsmode: 'host' } });
    expect(String((box.body.env as Record<string, string>).HOPPER_JOIN).startsWith(`${a.url}#`)).toBe(true);
    expect(libpod.volumes.has('hopper-sandbox-claude-home')).toBe(true);
    expect((await view(a, session)).boxes).toEqual([expect.objectContaining({ name: 'hopper-sandbox-claude', state: 'starting', runtime: 'remote', machine: 'studio', address: a.url })]);
  });

  it('a machine that is not a client target, or not dialled in, is refused, and nothing starts', async () => {
    const { a, session, libpod } = await boot();
    const nope = await launch(a, session, { machine: 'nope' });
    expect(nope.status).toBe(400);
    expect(nope.body.error).toBe('no client target nope: a sandbox box starts on the computer the hopper runs on, or on a machine that joined with Add machine');

    await clients.splice(0)[0]!.stop();
    await waitFor(async () => !((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'studio')!.online, { timeoutMs: 10000, what: 'studio offline' });
    const away = await launch(a, session, { machine: 'studio' });
    expect(away.status).toBe(409);
    expect(away.body.error).toMatch(/studio.*not dialled in/);
    expect(libpod.containers.size).toBe(0);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('the box on the machine is ready once it joins, and goes when its time limit passes', async () => {
    const { a, session, libpod } = await boot();
    await launch(a, session, { machine: 'studio', params: { ttlMinutes: 30 } });
    const line = String((onStudio(libpod, 'hopper-sandbox-claude')!.body.env as Record<string, string>).HOPPER_JOIN);
    await joinHopper({ line, name: 'hopper-sandbox-claude', dir: dir() });
    await a.app.sandboxes.reconcile();
    await a.app.sandboxes.reconcile();
    expect((await view(a, session)).boxes.map((b) => b.state)).toEqual(['ready']);

    await a.app.sandboxes.reconcile(new Date(Date.now() + 31 * 60_000));
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeUndefined();
    expect(libpod.volumes.has('hopper-sandbox-claude-home')).toBe(true);
    expect((await view(a, session)).boxes).toEqual([]);
  });

  it('while the machine is away its boxes are kept; once it dials in again they are checked', async () => {
    const { a, session, libpod, startStudio } = await boot();
    await launch(a, session, { machine: 'studio', params: { ttlMinutes: 30 } });
    await clients.splice(0)[0]!.stop();
    const later = new Date(Date.now() + 31 * 60_000);
    await a.app.sandboxes.reconcile(later);
    expect((await view(a, session)).boxes.map((b) => b.name)).toEqual(['hopper-sandbox-claude']);
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeDefined();

    startStudio();
    await online(a, 'studio');
    await a.app.sandboxes.reconcile(later);
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeUndefined();
    expect((await view(a, session)).boxes).toEqual([]);
  });
});
