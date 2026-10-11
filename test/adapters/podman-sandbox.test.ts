// Issues #603, #708: the sandbox module against real rootless Podman, through the real daemon and its HTTP route. It
// runs only where HOPPER_TEST_PODMAN_SOCKET names a rootless Podman API socket (`podman system service --time=0
// unix://<path>`), and an image that is already local (HOPPER_TEST_PODMAN_IMAGE; default the published box image), so
// it never pulls: elsewhere it is skipped. The box is on the host network, so its own client dials the test hopper.
//
// Feature: the hopper starts and removes a sandbox box through rootless Podman
//   Scenario: a box of a template starts with the sandbox flags and its limits, reports back, and is removed
//     Given rootless Podman and an approved template
//     When an admin starts a box of it
//     Then a container carries the hopper's labels, every capability dropped, no new privileges, a read-only root,
//       /tmp a tmpfs, its home the volume, a non-root user and the launch's limits
//     And its start check is its health check: bash with no profile and no rc, run in the box, passed at launch
//     And its client joins, so its record is ready
//     When its machine is removed
//     Then no container and no record of it are left, and its home volume stays
//   Scenario: a box on a network where the hopper does not answer does not start, and says why from inside (issue #708)
//     Given rootless Podman, and the boxes' network a bridge the hopper is not on
//     When an admin starts a box
//     Then the launch fails with what the box's start check wrote, and no container, volume or record is left
//   Scenario: a box on an attached machine starts in that machine's Podman, through its client (the remote runtime)
//     Given a machine joined and dialled in, its client given the rootless Podman socket
//     When an admin starts a box of an approved template on that machine
//     Then the container carries the sandbox flags and its sandbox label, its client joins, and its record is ready
//     When its machine is removed
//     Then no container and no record of it are left
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { createPodmanRuntime } from '../../src/sandbox/podman.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { KEY } from '../support/webhooks.ts';

const SOCKET = process.env.HOPPER_TEST_PODMAN_SOCKET;
const IMAGE = process.env.HOPPER_TEST_PODMAN_IMAGE ?? 'ghcr.io/henningfutrell/hopper:box-claude';
const podman = (...args: string[]): string => execFileSync('podman', ['--url', `unix://${SOCKET}`, ...args], { encoding: 'utf8' }).trim();

let t: TestApp | undefined;
let studio: Client | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await studio?.stop();
  studio = undefined;
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const until = async (what: string, ok: () => Promise<boolean>, ms = 90_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

describe.skipIf(!SOCKET)('the sandbox module, real rootless Podman', () => {
  it('starts a box of a template with the sandbox flags and its limits; it reports back, and is removed', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({
      dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
      plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } },
      seams: { containerRuntime: createPodmanRuntime(SOCKET!) },
    });
    const a = t;
    const session = await a.login();
    const name = `hopper-sandbox-t${a.app.instance.settings.instanceId().slice(0, 8)}`;
    cleanups.push(() => {
      try { podman('rm', '-f', '-t', '0', name); } catch { /* gone */ }
      try { podman('volume', 'rm', '-f', `${name}-home`); } catch { /* gone */ }
    });
    await a.ui('/ui/api/vault', { action: 'save-template', name: name.slice('hopper-sandbox-'.length), image: IMAGE, secrets: [], limits: { cpus: { default: 1, max: 2 }, memoryMb: { default: 1024, max: 2048 } } }, { token: session });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: name.slice('hopper-sandbox-'.length) }, { token: session });

    const r = await a.ui<{ container: string; error?: string }>('/ui/api/machines/sandbox', { template: name.slice('hopper-sandbox-'.length), params: { memoryMb: 1536 } }, { token: session });
    expect(r.body.error).toBeUndefined();
    expect(r.body.container).toBe(name);

    const inspect = JSON.parse(podman('container', 'inspect', name))[0] as {
      Config: { Labels: Record<string, string>; Env: string[]; User: string; Healthcheck?: { Test: string[] } };
      HostConfig: { CapAdd: string[]; SecurityOpt: string[]; ReadonlyRootfs: boolean; Tmpfs: Record<string, string>; RestartPolicy: { Name: string }; NanoCpus: number; CpuQuota: number; CpuPeriod: number; Memory: number };
      Mounts: { Type: string; Name?: string; Destination: string }[];
    };
    expect(inspect.Config.Labels).toMatchObject({ 'io.hopper.box': a.app.instance.settings.instanceId(), 'io.hopper.user': 'admin' });
    expect(inspect.Config.Env).toContain(`HOPPER_CLIENT_NAME=${name}`);
    expect(inspect.Config.User).toBe('agent');
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.CapAdd ?? []).toEqual([]);
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(inspect.HostConfig.Memory).toBe(1536 * 1024 * 1024);
    expect(inspect.HostConfig.NanoCpus || inspect.HostConfig.CpuQuota / inspect.HostConfig.CpuPeriod * 1e9).toBe(1e9);
    expect(inspect.Mounts.find((m) => m.Destination === '/home/agent')).toMatchObject({ Type: 'volume', Name: `${name}-home` });
    expect(Object.keys(inspect.HostConfig.Tmpfs ?? {}).concat(inspect.Mounts.filter((m) => m.Type === 'tmpfs').map((m) => m.Destination))).toContain('/tmp');
    const caps = JSON.parse(podman('container', 'inspect', '--format', '{{json .EffectiveCaps}}', name)) as string[] | null;
    expect(caps ?? []).toEqual([]);
    // The start check (issue #708): run in the box by Podman, it passed before the launch answered.
    expect(inspect.Config.Healthcheck?.Test).toEqual(['CMD', 'bash', '--noprofile', '--norc', '-c', `curl -fsS -m 5 -o /dev/null '${a.url}/client/install'`]);
    expect(a.app.instance.sandboxes.list()[0]!.check).toMatchObject({ passed: true });

    // Its own client joins the test hopper: once a machine names it, it is ready.
    const boxes = async (): Promise<{ name: string; state: string }[]> => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body.boxes;
    await until('the box to report back', async () => { await a.app.sandboxes.reconcile(); return (await boxes()).some((b) => b.name === name && b.state === 'ready'); });

    const { version } = (await a.api('GET', '/api/machines/config')).body as { version: string };
    expect((await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name, version }, { token: session })).status).toBe(200);
    await a.app.sandboxes.reconcile();
    await a.app.sandboxes.reconcile();
    expect(podman('ps', '-a', '--format', '{{.Names}}').split('\n')).not.toContain(name);
    expect(await boxes()).toEqual([]);
    expect(podman('volume', 'ls', '--format', '{{.Name}}').split('\n')).toContain(`${name}-home`);
  }, 180_000);

  it('starts a box on an attached machine in that machine\'s Podman, through its client', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const saved = { ...process.env };
    cleanups.push(() => { process.env = saved; });
    // The machine's herdr answers, so it shows online.
    const herdr = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
    chmodSync(herdr, 0o755);
    process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
    process.env.FAKE_HERDR_RUNNING = '1';
    t = await startTestApp({
      dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
      plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } },
    });
    const a = t;
    const session = await a.login();
    const dir = mkdtempSync(join(tmpdir(), 'hopper-machine-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await joinHopper({ line: `${a.url}#${(await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code}`, name: 'studio', dir });
    studio = startLinkedClient({ dir, herdrBin: herdr, session: 'hopper', installDir: testInstallDir(), backoffMs: [50], runtimeSockets: () => ({ podman: SOCKET! }) });
    await until('studio to dial in', async () => !!a.user().machineLink.client.named('studio')?.link());

    const template = `r${a.app.instance.settings.instanceId().slice(0, 8)}`;
    const name = `hopper-sandbox-${template}`;
    cleanups.push(() => {
      try { podman('rm', '-f', '-t', '0', name); } catch { /* gone */ }
      try { podman('volume', 'rm', '-f', `${name}-home`); } catch { /* gone */ }
    });
    await a.ui('/ui/api/vault', { action: 'save-template', name: template, image: IMAGE, secrets: [], limits: { cpus: { default: 1, max: 2 }, memoryMb: { default: 1024, max: 2048 } } }, { token: session });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: template }, { token: session });
    const r = await a.ui<{ container: string; error?: string }>('/ui/api/machines/sandbox', { template, machine: 'studio' }, { token: session });
    expect(r.body.error).toBeUndefined();
    expect(r.body.container).toBe(name);

    const inspect = JSON.parse(podman('container', 'inspect', name))[0] as {
      Config: { Labels: Record<string, string>; User: string };
      HostConfig: { SecurityOpt: string[]; ReadonlyRootfs: boolean; NetworkMode: string; Memory: number };
    };
    const record = a.app.instance.sandboxes.list()[0]!;
    expect(record).toMatchObject({ machine: 'studio', runtime: 'remote', address: a.url });
    expect(inspect.Config.Labels).toMatchObject({ 'io.hopper.box': a.app.instance.settings.instanceId(), 'io.hopper.user': 'admin', 'io.hopper.sandbox': record.id });
    expect(inspect.Config.User).toBe('agent');
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.HostConfig.NetworkMode).toBe('host');
    expect(inspect.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect(JSON.parse(podman('container', 'inspect', '--format', '{{json .EffectiveCaps}}', name)) ?? []).toEqual([]);

    const boxes = async (): Promise<{ name: string; state: string }[]> => (await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body.boxes;
    await until('the box to report back', async () => { await a.app.sandboxes.reconcile(); return (await boxes()).some((b) => b.name === name && b.state === 'ready'); });

    const { version } = (await a.api('GET', '/api/machines/config')).body as { version: string };
    expect((await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name, version }, { token: session })).status).toBe(200);
    await a.app.sandboxes.reconcile();
    await a.app.sandboxes.reconcile();
    expect(podman('ps', '-a', '--format', '{{.Names}}').split('\n')).not.toContain(name);
    expect(await boxes()).toEqual([]);
  }, 180_000);

  it('a box on a network where the hopper does not answer does not start, and says why from inside', async () => {
    const network = `hopper-t708-${Date.now().toString(36)}`;
    podman('network', 'create', network);
    cleanups.push(() => { try { podman('network', 'rm', '-f', network); } catch { /* gone */ } });
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({
      dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, env: { HOPPER_SANDBOX_NETWORK: network, HOPPER_LAN_NAMES: 'hopper' },
      plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['test'] } },
      seams: { containerRuntime: createPodmanRuntime(SOCKET!), startCheckMs: 5000 },
    });
    const a = t;
    const session = await a.login();
    const template = `u${a.app.instance.settings.instanceId().slice(0, 8)}`;
    const name = `hopper-sandbox-${template}`;
    cleanups.push(() => {
      try { podman('rm', '-f', '-t', '0', name); } catch { /* gone */ }
      try { podman('volume', 'rm', '-f', `${name}-home`); } catch { /* gone */ }
    });
    await a.ui('/ui/api/vault', { action: 'save-template', name: template, image: IMAGE, secrets: [] }, { token: session });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: template }, { token: session });

    const r = await a.ui<{ container?: string; error: string }>('/ui/api/machines/sandbox', { template }, { token: session });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(new RegExp(`^the sandbox box did not start: from inside the box ${name}, the hopper does not answer at http://hopper:\\d+: curl: \\(6\\) Could not resolve host: hopper`));
    expect(podman('ps', '-a', '--format', '{{.Names}}').split('\n')).not.toContain(name);
    expect(podman('volume', 'ls', '--format', '{{.Name}}').split('\n')).not.toContain(`${name}-home`);
    expect(a.app.instance.sandboxes.list()).toEqual([]);
  }, 120_000);
});
