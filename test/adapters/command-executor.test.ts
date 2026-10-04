// Issue #58: the command executor runs a job's command on the machine its lane is on, reached
// through that machine's connection — this machine (none), ssh, or docker exec into a container
// target that runs no agent (design.md "Container targets"). The container is real: alpine, no
// network, reached through an allowlisting socket proxy that lets through only it (issue #59). ssh
// is the stand-in from test/herdr (it hands the command to a local shell).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createCommandExecutor, scriptOf } from '../../src/executors/index.ts';
import { dockerHost } from '../../src/executors/docker.ts';
import { probeContainer } from '../../src/machines/index.ts';
import { startDockerProxy, type DockerProxy } from '../support/docker-proxy.ts';
import { testSshAuth } from '../support/ssh.ts';

const CONTAINER = `jh-test-target-${process.pid}`;
const OTHER = `jh-test-other-${process.pid}`;
let proxy: DockerProxy;
const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['command'] };
const BOX: MachineSnapshot = { id: 'box', label: 'box', maxLanes: 1, online: true, executors: ['command'], docker: CONTAINER };
const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');
let sshDir: string;

beforeAll(async () => {
  execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '--network', 'none', '--hostname', 'target-box', 'alpine:latest', 'sleep', '600']);
  execFileSync('docker', ['run', '-d', '--rm', '--name', OTHER, '--network', 'none', 'alpine:latest', 'sleep', '600']);
  proxy = await startDockerProxy([CONTAINER]);
  sshDir = mkdtempSync(join(tmpdir(), 'jh-ssh-'));
}, 60000);

afterAll(() => {
  proxy.stop();
  execFileSync('docker', ['rm', '-f', CONTAINER, OTHER]);
  rmSync(sshDir, { recursive: true, force: true });
});

function ctxFor(payload: Record<string, unknown>, machine: MachineSnapshot, signal = new AbortController().signal): ExecutionContext {
  const job: Job = {
    id: 'job-1234', spec: { executor: 'command', payload }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1,
  };
  return { job, laneId: `${machine.id}/lane-1`, machine, signal, progress() {}, saveState() {} };
}

describe('command executor', () => {
  const noSsh = () => { throw new Error('no ssh in this test'); };
  const ex = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh, dockerHost: () => proxy.host });

  it('runs the issue body in the container over docker exec and returns what it printed', async () => {
    const out = await ex.run(ctxFor({ body: 'hostname; echo "job $HOPPER_JOB_ID on $HOPPER_REPO"', env: { HOPPER_REPO: 'o/r' } }, BOX));
    expect(out).toEqual({ kind: 'finished', result: { machine: 'box', exitCode: 0, stdout: 'target-box\njob job-1234 on o/r\n', stderr: '' } });
  });

  it('a command that exits non-zero fails the job with its exit code and output', async () => {
    const out = await ex.run(ctxFor({ body: 'echo nope >&2; exit 3' }, BOX));
    expect(out).toEqual({ kind: 'failed', error: 'command exited 3 on box: nope' });
  });

  it('a container the socket proxy does not let through, there or not: fails the job, nothing run (issue #59)', async () => {
    for (const docker of [OTHER, 'jh-no-such-container']) {
      const out = await ex.run(ctxFor({ body: 'touch /tmp/ran' }, { ...BOX, docker }));
      expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^command exited 1 on box: .*Forbidden/) });
    }
    expect(() => execFileSync('docker', ['exec', OTHER, 'test', '-e', '/tmp/ran'])).toThrow();
  });

  it('without a socket only the hopper may open: fails the job, docker never run (issue #59)', async () => {
    const bad = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh, dockerHost: () => dockerHost(() => 'unix:///var/run/docker.sock') });
    const out = await bad.run(ctxFor({ body: 'true' }, BOX));
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^command on box: JOB_HOPPER_DOCKER_HOST .* refused/) });
  });

  it('runs on this machine when the lane is here', async () => {
    const out = await ex.run(ctxFor({ body: 'echo here' }, HERE));
    expect(out).toEqual({ kind: 'finished', result: { machine: 'local', exitCode: 0, stdout: 'here\n', stderr: '' } });
  });

  it('runs over ssh on an ssh target: one remote command, POSIX-quoted', async () => {
    const overSsh = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshBin: FAKE_SSH, sshAuth: testSshAuth(join(sshDir, 'auth')), dockerHost: () => proxy.host });
    process.env.FAKE_HERDR_DIR = sshDir;
    const out = await overSsh.run(ctxFor({ body: "echo 'it''s' there" }, { ...HERE, id: 'laptop', ssh: 'laptop' }));
    expect(out).toEqual({ kind: 'finished', result: { machine: 'laptop', exitCode: 0, stdout: 'its there\n', stderr: '' } });
    const call = JSON.parse(readFileSync(join(sshDir, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { argv: string[] };
    expect(call.argv.slice(call.argv.indexOf('--') + 1, -1)).toEqual(['laptop.example']);
  });

  it('cancel stops the command', async () => {
    const ac = new AbortController();
    const run = ex.run(ctxFor({ body: 'sleep 30' }, HERE, ac.signal));
    setTimeout(() => ac.abort('cancel'), 100);
    const t0 = Date.now();
    expect(await run).toEqual({ kind: 'failed', error: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('validates: a job needs a non-empty body', () => {
    expect(ex.validate({ body: 'ls' })).toBeNull();
    expect(ex.validate({ body: '  ' })).toMatch(/body/);
    expect(ex.validate({ prompt: 'ls' })).toMatch(/body/);
  });

  it('is not idempotent: a command is never run twice by a restart', () => {
    expect(ex.idempotent).toBe(false);
  });
});

describe('scriptOf', () => {
  it('the first fenced code block when the body has one, else the whole body', () => {
    expect(scriptOf('Run this:\n\n```sh\nuname -a\nid\n```\n\nthanks')).toBe('uname -a\nid\n');
    expect(scriptOf('uname -a\n')).toBe('uname -a\n');
  });
});

describe('container probe', () => {
  it('a running container is online, through the socket proxy', async () => {
    expect(await probeContainer({ container: CONTAINER, dockerHost: () => proxy.host })).toBe(true);
  });

  it('one the proxy does not let through, or no socket only the hopper may open: rejected with the reason', async () => {
    await expect(probeContainer({ container: OTHER, dockerHost: () => proxy.host })).rejects.toThrow(/Forbidden/);
    await expect(probeContainer({ container: CONTAINER, dockerHost: () => dockerHost(() => undefined) })).rejects.toThrow(/no docker socket for the hopper/);
  });
});
