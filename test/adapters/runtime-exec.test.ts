// Issue #1004: a command run in a box, and files copied into it, through the runtime's own API (test/support/fake-runtime-api.ts
// is the API double): the exec and archive calls Podman (libpod) and Docker share, each under its own API prefix.
//
// Feature: the hopper runs a command in a box through the runtime's API
//   Scenario: exec makes an exec session with the command and its environment, starts it attached, splits the framed
//     output into stdout and stderr, and answers the session's exit code
//   Scenario: a refusal is the runtime's own words
//   Scenario: copyIn puts a tar into a directory of the box, owned by the box's user
//   Scenario: a runtime reached through a machine's client runs no command in a box
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

/** One frame of an attached stream: the stream's byte, three zero bytes, the length, the bytes. */
const frame = (stream: 1 | 2, text: string): Buffer => {
  const data = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
};

const RUNTIMES = [
  { kind: 'podman', prefix: '/v5.0.0/libpod', make: (socket: string) => createPodmanRuntime(socket) },
  { kind: 'docker', prefix: '/v1.41', make: (socket: string) => createDockerRuntime(socket) },
] as const;

describe.each(RUNTIMES)('the $kind runtime runs a command in a box (issue #1004)', ({ prefix, make }) => {
  it('makes an exec session, starts it attached, splits stdout from stderr, and answers its exit code', async () => {
    api = await startFakeRuntimeApi([
      on('POST', `${prefix}/containers/c1/exec`, { status: 201, body: { Id: 'e1' } }),
      on('POST', `${prefix}/exec/e1/start`, { status: 200, bytes: Buffer.concat([frame(1, 'hello '), frame(2, 'warn\n'), frame(1, 'world\n')]) }),
      on('GET', `${prefix}/exec/e1/json`, { status: 200, body: { Running: false, ExitCode: 4 } }),
    ]);
    const out: { stream: number; text: string }[] = [];
    const exit = await make(api.socket).exec!('c1', { cmd: ['sh', '-c', 'echo hello'], env: { HOPPER_TOKEN_FILE: '/home/agent/t' }, out: (chunk, stream) => out.push({ stream, text: chunk.toString('utf8') }) });
    expect(exit).toBe(4);
    expect(out).toEqual([{ stream: 1, text: 'hello ' }, { stream: 2, text: 'warn\n' }, { stream: 1, text: 'world\n' }]);
    expect(api.seen[0]!.body).toEqual({ AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: ['sh', '-c', 'echo hello'], Env: ['HOPPER_TOKEN_FILE=/home/agent/t'] });
    expect(api.seen[1]!.body).toEqual({ Detach: false, Tty: false });
  });

  it('a refusal is the runtime\'s own words', async () => {
    api = await startFakeRuntimeApi([on('POST', `${prefix}/containers/c1/exec`, { status: 409, body: { message: 'container c1 is not running' } })]);
    await expect(make(api.socket).exec!('c1', { cmd: ['true'], out: () => undefined })).rejects.toThrow(/container c1 is not running/);
  });

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
  it('runs no command in a box: a box step runs only in a box beside the hopper', () => {
    const relay: RuntimeRelay = { which: async () => ({ kind: 'podman' }), call: async () => ({ status: 200, text: '{}' }) };
    const rt = createRemoteRuntime('studio', relay);
    expect(rt.exec).toBeUndefined();
    expect(rt.copyIn).toBeUndefined();
  });
});
