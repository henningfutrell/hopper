// Issue #1004: files copied into a box, through the runtime's own API (test/support/fake-runtime-api.ts is the API
// double): the archive call Podman (libpod) and Docker share, each under its own API prefix.
//
// Feature: the hopper copies files into a box through the runtime's API
//   Scenario: copyIn puts a tar into a directory of the box, owned by the box's user
//   Scenario: a runtime reached through a machine's client copies nothing into a box
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeRelay } from '../../src/domain/sandboxes.ts';
import { createDockerRuntime } from '../../src/sandbox/docker.ts';
import { createPodmanRuntime } from '../../src/sandbox/podman.ts';
import { createRemoteRuntime } from '../../src/sandbox/remote.ts';
import { on, startFakeRuntimeApi, type FakeRuntimeApi } from '../support/fake-runtime-api.ts';

let api: FakeRuntimeApi | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await api?.close();
  api = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RUNTIMES = [
  { kind: 'podman', prefix: '/v5.0.0/libpod', make: (socket: string) => createPodmanRuntime(socket) },
  { kind: 'docker', prefix: '/v1.41', make: (socket: string) => createDockerRuntime(socket) },
] as const;

describe.each(RUNTIMES)('the $kind runtime copies files into a box (issue #1004)', ({ prefix, make }) => {
  it('copyIn puts a tar into a directory of the box, owned by the box\'s user', async () => {
    api = await startFakeRuntimeApi([on('PUT', `${prefix}/containers/c1/archive`, { status: 200 })]);
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'in.tar'), 'TARBYTES');
    await make(api.socket).copyIn!('c1', '/home/agent/work', join(dir, 'in.tar'));
    expect(api.seen[0]!.query.get('path')).toBe('/home/agent/work');
    expect(api.seen[0]!.query.get('copyUIDGID')).toBe('true');
    expect(api.seen[0]!.body).toBe('TARBYTES');
  });
});

describe('a runtime on another machine (issue #1004)', () => {
  it('copies nothing into a box', () => {
    const relay: RuntimeRelay = { which: async () => ({ kind: 'podman' }), call: async () => ({ status: 200, text: '{}' }) };
    expect(createRemoteRuntime('studio', relay).copyIn).toBeUndefined();
  });
});
