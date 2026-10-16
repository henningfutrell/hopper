// Issue #1349, through the real composition root, the real HTTP server and a real client dialled in: a box an older
// build launched on an attached machine is burned there, through that machine's own Podman, its calls carried by the
// machine's client (the remote runtime). The machine's Podman is a libpod double (test/support/fake-libpod.ts); the
// hopper's own runtime a double at its port, which a box on a machine never touches.
//
// Feature: boxes an older build launched on an attached machine are burned
//   Scenario: the box on the machine is stopped and removed through its client, and its record goes
//   Scenario: while the machine is away its box and its record are kept; once it dials in again the box is burned
//   Scenario: the machine's client makes no sandbox box: a sandbox never joins as a machine
//   Scenario: a box an older build launched on the machine with no sandbox record is burned all the same
//   Scenario: a need box on the machine that outlived its step is burned by the sweep, with its home, and its run ends as swept
//   Scenario: while the machine is away its open run stays open; once it dials in again the sweep burns its box
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startLinkedClient } from '../../src/client/main.ts';
import { runtimeRelay } from '../../src/executors/client.ts';
import { joinHopper } from '../../src/client/join.ts';
import type { Client } from '../../src/client/server.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { BOX_LABEL, USER_LABEL } from '../../src/sandbox/service.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { createFakeLibpod, type FakeLibpod } from '../support/fake-libpod.ts';
import { startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

// The machine's herdr answers, so it shows online (test/integration/machine-join.test.ts does the same).
const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const saved = { ...process.env };

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
  process.env = { ...saved };
});

const PLUGINS = { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } };
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'hopper-machine-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

interface Setup { a: TestApp; session: string; local: FakeContainerRuntime; libpod: FakeLibpod; studio: string; startStudio(): void }

/** A hopper, and a machine `studio` joined and dialled in, its client carrying runtime calls to its own Podman. */
async function boot(): Promise<Setup> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
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
    clients.push(startLinkedClient({ dir: studio, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50], runtimeSockets: () => ({ podman: socket }) }));
  };
  startStudio();
  await online(t, 'studio');
  return { a: t, session, local, libpod, studio, startStudio };
}

const online = (a: TestApp, name: string) => waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
/** Whether the hopper holds studio's link now. */
const dialled = (a: TestApp): boolean => { const l = a.user().machineLink.client.named('studio')?.link(); return !!l && !l.destroyed; };
const away = (a: TestApp) => waitFor(() => !dialled(a), { timeoutMs: 5000, what: 'studio\'s link closed' });
const onStudio = (libpod: FakeLibpod, name: string) => [...libpod.containers.values()].find((c) => c.name === name);

/** A box an older build launched on studio: its container there and its record. */
function launchedOnStudio(a: TestApp, libpod: FakeLibpod): void {
  libpod.put({ name: 'hopper-sandbox-claude', image: 'ghcr.io/henningfutrell/hopper:box-claude', labels: { [BOX_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin' } });
  a.app.instance.sandboxes.add({ id: 'sbx-1', userId: 'admin', name: 'hopper-sandbox-claude', image: 'ghcr.io/henningfutrell/hopper:box-claude', machine: 'studio' });
}

/** A need box on studio that no step holds: one a step left, or a hopper that stopped mid-step. Its home volume too. */
async function needBoxOnStudio(a: TestApp, libpod: FakeLibpod, name: string): Promise<void> {
  const labels = { [NEED_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin' };
  const made = await runtimeRelay(a.user().machineLink.client.named('studio')!).call({ method: 'POST', path: '/v5.0.0/libpod/volumes/create', body: { Name: `${name}-home`, Label: labels } });
  expect(made.status).toBe(201);
  libpod.put({ name, image: 'ghcr.io/henningfutrell/hopper:box-claude', labels });
}

describe('boxes an older build launched on an attached machine are burned', () => {
  it('the box on the machine is stopped and removed through its client, and its record goes', async () => {
    const { a, local, libpod } = await boot();
    launchedOnStudio(a, libpod);
    await a.app.sandboxes.burnLaunched();
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeUndefined();
    expect(a.app.instance.sandboxes.list()).toEqual([]);
    expect(local.boxes.size).toBe(0);
  });

  it('while the machine is away its box and its record are kept; once it dials in again the box is burned', async () => {
    const { a, libpod, startStudio } = await boot();
    launchedOnStudio(a, libpod);
    for (const c of clients.splice(0)) await c.stop();
    await away(a);
    await a.app.sandboxes.burnLaunched();
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeDefined();
    expect(a.app.instance.sandboxes.list().map((r) => r.name)).toEqual(['hopper-sandbox-claude']);

    startStudio();
    await waitFor(() => dialled(a), { timeoutMs: 10000, what: 'studio dialled in again' });
    await a.app.sandboxes.burnLaunched();
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeUndefined();
    expect(a.app.instance.sandboxes.list()).toEqual([]);
  });

  it('the machine\'s client makes no sandbox box: a sandbox never joins as a machine', async () => {
    const { a, libpod } = await boot();
    const relay = a.user().machineLink.client.named('studio')!;
    const labels = { [BOX_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin' };
    const create = await runtimeRelay(relay).call({ method: 'POST', path: '/v5.0.0/libpod/containers/create', body: {
      name: 'hopper-sandbox-claude', image: 'ghcr.io/henningfutrell/hopper:box-claude', labels, env: {}, user: 'agent', cap_drop: ['ALL'], no_new_privileges: true,
      read_only_filesystem: true, read_only_tmpfs: false, mounts: [{ destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['rw'] }],
      volumes: [{ Name: 'hopper-sandbox-claude-home', Dest: '/home/agent' }], restart_policy: 'unless-stopped', netns: { nsmode: 'host' },
    } });
    expect(create.status).toBe(403);
    expect(create.text).toContain('a sandbox never joins as a machine');
    expect(onStudio(libpod, 'hopper-sandbox-claude')).toBeUndefined();
  });

  it('a box an older build launched on the machine with no sandbox record is burned all the same', async () => {
    const { a, libpod } = await boot();
    libpod.put({ name: 'hopper-sandbox-claude-2', image: 'ghcr.io/henningfutrell/hopper:box-claude', labels: { [BOX_LABEL]: a.app.instance.settings.instanceId(), [USER_LABEL]: 'admin' } });
    // Another hopper's box on the same machine stays.
    libpod.put({ name: 'hopper-sandbox-other', image: 'ghcr.io/henningfutrell/hopper:box-claude', labels: { [BOX_LABEL]: 'another-hopper', [USER_LABEL]: 'admin' } });
    expect(a.app.instance.sandboxes.list()).toEqual([]);
    await a.app.sandboxes.burnLaunched();
    expect(onStudio(libpod, 'hopper-sandbox-claude-2')).toBeUndefined();
    expect(onStudio(libpod, 'hopper-sandbox-other')).toBeDefined();
  });
});

describe('the sweep burns sandboxes on an attached machine (issue #1349)', () => {
  it('a need box on the machine that outlived its step is burned by the sweep, with its home, and its run ends as swept', async () => {
    const { a, local, libpod } = await boot();
    const runs = a.app.instance.sandboxRuns;
    runs.start({ id: 's-studio', userId: 'admin', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-eeee', machine: 'studio', startedAt: '2026-10-15T11:00:00.000Z' });
    await needBoxOnStudio(a, libpod, 'hopper-need-asked-1-eeee');
    // A need box of no run: a step whose run was never written. It is burned too.
    await needBoxOnStudio(a, libpod, 'hopper-need-asked-1-ffff');
    await a.app.sandboxes.check();
    expect(onStudio(libpod, 'hopper-need-asked-1-eeee')).toBeUndefined();
    expect(onStudio(libpod, 'hopper-need-asked-1-ffff')).toBeUndefined();
    expect([...libpod.volumes]).toEqual([]);
    expect(runs.get('s-studio')).toMatchObject({ outcome: 'swept', endedAt: expect.any(String), destroyedAt: expect.any(String), problem: expect.stringContaining('burned by the sweep') });
    expect(runs.open()).toEqual([]);
    expect(local.boxes.size).toBe(0);
  });

  it('while the machine is away its open run stays open; once it dials in again the sweep burns its box', async () => {
    const { a, libpod, startStudio } = await boot();
    const runs = a.app.instance.sandboxRuns;
    runs.start({ id: 's-away', userId: 'admin', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-gggg', machine: 'studio', startedAt: '2026-10-15T11:00:00.000Z' });
    await needBoxOnStudio(a, libpod, 'hopper-need-asked-1-gggg');
    for (const c of clients.splice(0)) await c.stop();
    await away(a);
    await a.app.sandboxes.check();
    expect(onStudio(libpod, 'hopper-need-asked-1-gggg')).toBeDefined();
    expect(runs.get('s-away')!.destroyedAt).toBeUndefined();

    startStudio();
    await waitFor(() => dialled(a), { timeoutMs: 10000, what: 'studio dialled in again' });
    await a.app.sandboxes.check();
    expect(onStudio(libpod, 'hopper-need-asked-1-gggg')).toBeUndefined();
    expect(runs.get('s-away')).toMatchObject({ outcome: 'swept', destroyedAt: expect.any(String) });
  });
});
