// Issue #603: the sandbox engine against real rootless Podman. It runs only where HOPPER_TEST_PODMAN_SOCKET names a
// rootless Podman API socket (`podman system service --time=0 unix://<path>`), and an image that is already local
// (HOPPER_TEST_PODMAN_IMAGE; default the published box image), so it never pulls: elsewhere it is skipped.
//
// Feature: the hopper starts and removes a sandbox box through rootless Podman
//   Scenario: a box is launched with the sandbox flags, and removed with its volume
//     Given rootless Podman
//     When the engine launches a box
//     Then a container of that name carries the hopper's labels, every capability dropped, no new privileges,
//       a read-only root, /tmp a tmpfs and its home the volume
//     When the engine removes it
//     Then no container and no volume of it are left
//   Scenario: removing a box that is already gone is no error
//   Scenario: a socket that is no Podman is a problem, said with the socket
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPodmanEngine } from '../../src/sandboxes/podman.ts';

const SOCKET = process.env.HOPPER_TEST_PODMAN_SOCKET;
const IMAGE = process.env.HOPPER_TEST_PODMAN_IMAGE ?? 'ghcr.io/henningfutrell/hopper:box-claude';
const podman = (...args: string[]): string => execFileSync('podman', ['--url', `unix://${SOCKET}`, ...args], { encoding: 'utf8' }).trim();

const made: string[] = [];
afterEach(() => {
  for (const name of made.splice(0)) {
    try { podman('rm', '-f', '-t', '0', name); } catch { /* gone */ }
    try { podman('volume', 'rm', '-f', `${name}-home`); } catch { /* gone */ }
  }
});

describe.skipIf(!SOCKET)('the sandbox engine, real rootless Podman', () => {
  it('launches a box with the sandbox flags and its labels, then removes it with its volume', async () => {
    const engine = createPodmanEngine(SOCKET!);
    expect(await engine.problem()).toBeUndefined();
    const name = `hopper-sandbox-t${randomBytes(4).toString('hex')}`;
    made.push(name);
    const labels = { 'io.hopper.box': `test-${name}`, 'io.hopper.user': 'admin' };
    await engine.launch({ name, image: IMAGE, network: 'podman', volume: `${name}-home`, env: { HOPPER_CLIENT_NAME: name }, labels });

    expect((await engine.names()).has(name)).toBe(true);
    expect((await engine.list(labels)).map((c) => c.name)).toEqual([name]);
    const inspect = JSON.parse(podman('container', 'inspect', name))[0] as {
      Config: { Labels: Record<string, string>; Env: string[] };
      HostConfig: { CapDrop: string[]; CapAdd: string[]; SecurityOpt: string[]; ReadonlyRootfs: boolean; Tmpfs: Record<string, string>; RestartPolicy: { Name: string } };
      Mounts: { Type: string; Name?: string; Destination: string }[];
    };
    expect(inspect.Config.Labels).toMatchObject(labels);
    expect(inspect.Config.Env).toContain(`HOPPER_CLIENT_NAME=${name}`);
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.CapAdd ?? []).toEqual([]);
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(inspect.Mounts.find((m) => m.Destination === '/home/agent')).toMatchObject({ Type: 'volume', Name: `${name}-home` });
    expect(Object.keys(inspect.HostConfig.Tmpfs ?? {}).concat(inspect.Mounts.filter((m) => m.Type === 'tmpfs').map((m) => m.Destination))).toContain('/tmp');
    // Every capability dropped: the process in it holds none.
    const caps = JSON.parse(podman('container', 'inspect', '--format', '{{json .EffectiveCaps}}', name)) as string[] | null;
    expect(caps ?? []).toEqual([]);

    await engine.remove(name, `${name}-home`);
    expect((await engine.names()).has(name)).toBe(false);
    expect(podman('volume', 'ls', '--format', '{{.Name}}').split('\n')).not.toContain(`${name}-home`);
  }, 120_000);

  it('removing a box that is already gone is no error', async () => {
    const engine = createPodmanEngine(SOCKET!);
    await expect(engine.remove(`hopper-sandbox-gone${randomBytes(4).toString('hex')}`, 'hopper-sandbox-gone-home')).resolves.toBeUndefined();
  });
});

describe('the sandbox engine, no Podman', () => {
  it('a socket nothing listens on is a problem that names the socket', async () => {
    const engine = createPodmanEngine('/nonexistent/podman.sock');
    expect(await engine.problem()).toMatch(/^cannot reach podman at \/nonexistent\/podman\.sock: /);
  });
});
