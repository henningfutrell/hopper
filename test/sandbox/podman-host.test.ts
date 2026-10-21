// Issue #2272 part 2: a Podman host, reached over ssh. Each call of the Podman adapter goes down `ssh <host> podman
// system dial-stdio` — the hopper's own key, the host's pinned key only, the hardened options — to the host's rootless
// Podman, so a box there is made with the same sandbox flags as one beside the hopper. A box with vault secrets runs
// there: they go in by a copy, over the same stream. A wait whose connection dropped finds the box again and waits
// again. The most CPU and memory a box gets there is the host's. Its health is ssh plus libpod /info.
// The host's Podman is a libpod double on a unix socket; ssh is a fake that joins its stdio to that socket.
//
// Feature: a Podman host over ssh
//   Scenario: its health: ssh and libpod /info, with the hardened options and the host's own pin
//   Scenario: ssh cannot connect: the health says why
//   Scenario: a need box with vault secrets runs there: the secrets go in by a copy, its limits are the host's
//   Scenario: a wait whose connection dropped finds the box again, and the step ends with its exit code
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PodmanHost } from '../../src/domain/podman-hosts.ts';
import { runNeedBox } from '../../src/sandbox/need-box.ts';
import { createPodmanHostRuntime, DIAL_STDIO } from '../../src/sandbox/podman-host.ts';
import { createFakeLibpod, type FakeLibpod } from '../support/fake-libpod.ts';
import { startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

const FAKE = fileURLToPath(new URL('./fake-ssh-podman.mjs', import.meta.url));
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const HOST: PodmanHost = { name: 'box-vm', ssh: 'sandbox@box-vm', hostKey: KEY, cpus: 2, memoryMb: 1024 };

let dir: string, libpod: FakeLibpod, api: FakeRuntimeApi;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'podman-host-'));
  libpod = createFakeLibpod();
  api = await startFakeRuntimeApi(libpod.handlers);
  Object.assign(process.env, { FAKE_SSH_DIR: dir, FAKE_PODMAN_SOCKET: api.socket });
  chmodSync(FAKE, 0o755);
});
afterEach(async () => {
  await api.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ['FAKE_SSH_DIR', 'FAKE_PODMAN_SOCKET', 'FAKE_SSH_FAIL', 'FAKE_SSH_DROP_WAIT']) delete process.env[k];
});

function runtime(host: PodmanHost = HOST) {
  const key = join(dir, 'id');
  writeFileSync(key, 'key', { mode: 0o600 });
  return createPodmanHostRuntime(host, { auth: () => ({ identityFile: key, knownHostsFile: join(dir, 'targets_known_hosts') }), sshDir: join(dir, 'ssh'), sshBin: FAKE, retryMs: 10 });
}
const calls = (): string[][] => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]).filter((a) => a[0] !== '-G');

describe('a Podman host over ssh (issue #2272)', () => {
  it('its health is ssh plus libpod /info, with the hardened options, the hopper\'s key and the host\'s own pin', async () => {
    expect(await runtime().problem()).toBeUndefined();
    expect(api.seen.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v5.0.0/libpod/info']);
    const [call] = calls();
    expect(call).toEqual(expect.arrayContaining(['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'HostKeyAlias=sandbox@box-vm', '-i', join(dir, 'id')]));
    expect(call).toContain(`UserKnownHostsFile=${join(dir, 'ssh', 'podman', 'box-vm.known_hosts')}`);
    expect(call!.slice(-7)).toEqual(['-p', '22', '-l', 'sandbox', '--', 'box-vm', 'podman system dial-stdio']);
    expect(DIAL_STDIO).toBe('podman system dial-stdio');
    expect(readFileSync(join(dir, 'ssh', 'podman', 'box-vm.known_hosts'), 'utf8')).toBe(`sandbox@box-vm ${KEY}\n`);
  });

  it('says why when ssh cannot connect', async () => {
    process.env.FAKE_SSH_FAIL = '1';
    expect(await runtime().problem()).toMatch(/^cannot reach podman on box-vm: ssh to box-vm failed \(exit 255\): sandbox@box-vm: Permission denied \(publickey\)\.$/);
  });

  it('runs a need box with vault secrets there: they go in by a copy, and the box gets at most the host\'s CPU and memory', async () => {
    const box = { name: 'hopper-need-asked-1-aaaa', userId: 'u1', instanceId: 'test', network: 'host', template: { image: 'img', limits: { cpus: { default: 8, max: 8 }, memoryMb: { default: 4096, max: 4096 } } }, env: {}, timeoutMs: 10_000, dir, files: { secrets: { 'db-password': 'hunter2' } } };
    const r = await runNeedBox(runtime(), box, { log: () => {}, signal: new AbortController().signal, pollMs: 5 });
    expect(r.exit).toBe(0);
    expect(libpod.copies.map((c) => c.container)).toContain('hopper-need-asked-1-aaaa');
    expect(libpod.copies.some((c) => c.tar.includes('hunter2'))).toBe(true);
    const created = api.seen.find((s) => s.path.endsWith('/containers/create'))!.body as { resource_limits: { cpu: { quota: number; period: number }; memory: { limit: number } }; env?: Record<string, string> };
    expect(created.resource_limits.cpu.quota / created.resource_limits.cpu.period).toBe(2);
    expect(created.resource_limits.memory.limit).toBe(1024 * 1024 * 1024);
    expect(JSON.stringify(created.env ?? {})).not.toContain('hunter2');
  });

  it('a wait whose connection dropped finds the box again and waits again', async () => {
    process.env.FAKE_SSH_DROP_WAIT = '1';
    const rt = runtime();
    const id = libpod.put({ name: 'hopper-need-asked-2-bbbb', image: 'img', labels: { 'hopper.need': 'test' }, run: { exit: 3, logs: Buffer.alloc(0) } });
    expect(await rt.wait(id, 5000)).toBe(3);
    const waits = api.seen.filter((s) => s.path.endsWith('/wait')).length;
    expect(waits).toBe(1);
    expect(api.seen.some((s) => s.path === `/v5.0.0/libpod/containers/${id}/json`)).toBe(true);
  });
});
