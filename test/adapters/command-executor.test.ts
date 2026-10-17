// Issue #58: the command executor runs a job's command on the machine its lane is on, reached
// through that machine's connection — this machine (none), ssh, or, on a container target, a one-shot
// sandbox box of its own that the sandbox module starts and burns (issue #865 part C, design.md
// "Container targets"). The sandbox module is a double at the CommandBoxes seam; ssh is the stand-in
// from test/herdr (it hands the command to a local shell).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandBox, CommandBoxes } from '../../src/domain/sandboxes.ts';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createCommandExecutor, scriptOf } from '../../src/executors/index.ts';
import { testSshAuth } from '../support/ssh.ts';

const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['command'] };
const BOX: MachineSnapshot = { id: 'box', label: 'box', maxLanes: 1, online: true, executors: ['command'], containerImage: 'example/box:1' };
const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');
let sshDir: string;

beforeAll(() => { sshDir = mkdtempSync(join(tmpdir(), 'jh-ssh-')); });
afterAll(() => { rmSync(sshDir, { recursive: true, force: true }); });

function ctxFor(payload: Record<string, unknown>, machine: MachineSnapshot, signal = new AbortController().signal): ExecutionContext {
  const job: Job = {
    id: 'job-1234', spec: { executor: 'command', payload }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1,
  };
  return { job, laneId: `${machine.id}/lane-1`, machine, signal, progress() {}, saveState() {}, workTree() {} };
}

/** The sandbox module as the command executor sees it: each box it was asked for, and what the box writes and ends with. */
function fakeBoxes(answer: (box: CommandBox, io: { log(chunk: string): void; signal: AbortSignal }) => Promise<{ exit: number; problem?: string; stopped?: 'timed-out' | 'cancelled' }>): CommandBoxes & { asked: CommandBox[] } {
  const asked: CommandBox[] = [];
  return { asked, problem: async () => undefined, run: async (box, io) => { asked.push(box); return answer(box, io); } };
}

describe('command executor', () => {
  const noSsh = () => { throw new Error('no ssh in this test'); };
  const ex = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh });

  it('on a container target, runs the body in a one-shot sandbox box of its image and returns what it wrote', async () => {
    const boxes = fakeBoxes(async (_box, io) => { io.log('target-box\r\n'); io.log('job job-1234 on o/r\r\n'); return { exit: 0 }; });
    const onBox = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh, boxes });
    const out = await onBox.run(ctxFor({ body: 'Run:\n\n```sh\nhostname\n```\n', env: { HOPPER_REPO: 'o/r' } }, BOX));
    expect(out).toEqual({ kind: 'finished', result: { machine: 'box', exitCode: 0, stdout: 'target-box\njob job-1234 on o/r\n', stderr: '' } });
    expect(boxes.asked).toEqual([{ jobId: 'job-1234', image: 'example/box:1', script: 'hostname\n', env: { HOPPER_REPO: 'o/r', HOPPER_JOB_ID: 'job-1234' }, timeoutMs: 20000 }]);
  });

  it('on a container target, a command that exits non-zero fails the job with its exit code and output', async () => {
    const onBox = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh, boxes: fakeBoxes(async (_b, io) => { io.log('nope\r\n'); return { exit: 3 }; }) });
    expect(await onBox.run(ctxFor({ body: 'echo nope >&2; exit 3' }, BOX))).toEqual({ kind: 'failed', error: 'command exited 3 on box: nope' });
  });

  it('on a container target, a box that did not run, or ran past its time, fails the job with the reason', async () => {
    const noRun = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh, boxes: fakeBoxes(async () => ({ exit: 125, problem: 'the need box did not run: no image' })) });
    expect(await noRun.run(ctxFor({ body: 'true' }, BOX))).toEqual({ kind: 'failed', error: 'command on box: the need box did not run: no image' });
    const late = createCommandExecutor({ name: 'command', timeoutMs: 50, sshAuth: noSsh, boxes: fakeBoxes(async () => ({ exit: 125, problem: 'late', stopped: 'timed-out' })) });
    expect(await late.run(ctxFor({ body: 'sleep 9' }, BOX))).toEqual({ kind: 'failed', error: 'command on box timed out after 50 ms' });
  });

  it('on a container target, a cancel stops the box', async () => {
    const boxes = fakeBoxes((_b, io) => new Promise((resolve) => { io.signal.addEventListener('abort', () => resolve({ exit: 125, problem: 'stopped', stopped: 'cancelled' })); }));
    const onBox = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshAuth: noSsh, boxes });
    const ac = new AbortController();
    const run = onBox.run(ctxFor({ body: 'sleep 30' }, BOX, ac.signal));
    setTimeout(() => ac.abort('cancel'), 20);
    expect(await run).toEqual({ kind: 'failed', error: 'aborted' });
  });

  it('on a container target with no sandbox module: fails the job, nothing run here', async () => {
    expect(await ex.run(ctxFor({ body: 'touch ran' }, BOX))).toEqual({ kind: 'failed', error: 'command on box: this hopper starts no sandbox box, so a container target runs no command' });
  });

  it('runs on this machine when the lane is here', async () => {
    const out = await ex.run(ctxFor({ body: 'echo here' }, HERE));
    expect(out).toEqual({ kind: 'finished', result: { machine: 'local', exitCode: 0, stdout: 'here\n', stderr: '' } });
  });

  it('runs over ssh on an ssh target: one remote command, POSIX-quoted', async () => {
    const overSsh = createCommandExecutor({ name: 'command', timeoutMs: 20000, sshBin: FAKE_SSH, sshAuth: testSshAuth(join(sshDir, 'auth')) });
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

