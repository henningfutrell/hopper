// Issue #142: a job can run in Cursor's agent, not only in Claude Code. The cursor-agent executor runs
// Cursor's CLI agent in print mode on the job's machine — this one, or an ssh target — in the job's
// work tree, and reads the hopper protocol's marker from its answer: done, a question (answered by
// resuming the same Cursor chat), or failed (design.md "Cursor executor"). `cursor-agent` and ssh are
// stand-ins; the ssh one hands the command to a local shell.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createCursorExecutor } from '../../src/executors/index.ts';
import { testSshAuth } from '../support/ssh.ts';

const FAKE_CURSOR = join(import.meta.dirname, 'fake-cursor-agent.mjs');
const FAKE_SSH = join(import.meta.dirname, '..', 'herdr', 'fake-ssh-bin.mjs');
const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['cursor'] };
const LAPTOP: MachineSnapshot = { ...HERE, id: 'laptop', ssh: 'laptop' };
let dir: string;
let work: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-cursor-'));
  work = join(dir, 'work');
  process.env.FAKE_CURSOR_DIR = dir;
  process.env.FAKE_HERDR_DIR = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.FAKE_CURSOR_MODE;
  rmSync(join(dir, 'cursor-calls.jsonl'), { force: true });
});

interface Call { argv: string[]; cwd: string; env: Record<string, string | undefined> }
const calls = (): Call[] => readFileSync(join(dir, 'cursor-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call);
const reply = (text: string) => { process.env.FAKE_CURSOR_REPLY = text; };

function ctxFor(payload: Record<string, unknown>, machine: MachineSnapshot, o: { state?: Record<string, unknown>; signal?: AbortSignal } = {}) {
  const saved: Record<string, unknown>[] = [];
  const workTrees: string[] = [];
  const job: Job = {
    id: 'job-1234', spec: { executor: 'cursor', payload }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1, ...(o.state ? { executorState: o.state } : {}),
  };
  const ctx: ExecutionContext = {
    job, laneId: `${machine.id}/lane-1`, machine, signal: o.signal ?? new AbortController().signal, progress() {}, saveState: (s) => { saved.push(s); },
    workTree: (path) => { workTrees.push(path); },
  };
  return { ctx, saved, workTrees };
}

describe('cursor-agent executor', () => {
  const noSsh = () => { throw new Error('no ssh in this test'); };
  const ex = createCursorExecutor({ name: 'cursor', bin: FAKE_CURSOR, args: ['--force', '--trust'], defaultCwd: '/nowhere', sshAuth: noSsh });

  it('runs Cursor in print mode in the job\'s work tree, with the hopper protocol after the prompt, and finishes on HOPPER_DONE', async () => {
    reply('I wrote greeting.txt.\n\nHOPPER_DONE');
    const out = await ex.run(ctxFor({ prompt: 'Write a greeting', cwd: work, env: { HOPPER_REPO: 'o/r' }, model: 'sonnet-4' }, HERE).ctx);
    expect(out).toEqual({ kind: 'finished', result: { machine: 'local', summary: 'I wrote greeting.txt.', chatId: 'chat-1' } });
    const [call] = calls();
    expect(call!.cwd).toBe(work);
    expect(call!.env).toEqual({ TMPDIR: `${work}/.hopper-scratch`, HOPPER_JOB_ID: 'job-1234', HOPPER_REPO: 'o/r' });
    expect(call!.argv.slice(0, -1)).toEqual(['-p', '--output-format', 'json', '--workspace', work, '--force', '--trust', '--model', 'sonnet-4', '--']);
    expect(call!.argv.at(-1)).toMatch(/^Write a greeting\n\n\[hopper publishing rule\][\s\S]*HOPPER_FAILED followed by the reason\.$/);
    expect(readFileSync(join(work, '.hopper-scratch', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('reports the job\'s work tree, so the lane running it shows where it works (issue #166)', async () => {
    reply('Done.\n\nHOPPER_DONE');
    const { ctx, workTrees } = ctxFor({ prompt: 'go', cwd: work }, HERE);
    await ex.run(ctx);
    expect(workTrees).toEqual([work]);
  });

  it('a question parks the job with its chat; the answer resumes that chat', async () => {
    reply('Which language should it be in?\nHOPPER_QUESTION');
    const first = ctxFor({ prompt: 'Write a greeting', cwd: work }, HERE);
    expect(await ex.run(first.ctx)).toEqual({
      kind: 'question', question: { text: 'Which language should it be in?', recentOutput: 'Which language should it be in?\nHOPPER_QUESTION', detectedBy: 'marker' },
    });
    expect(first.saved.at(-1)).toEqual({ chatId: 'chat-1', cwd: work });
    process.env.FAKE_CURSOR_REPLY = 'Done in French.\n**HOPPER_DONE**';
    const next = ctxFor({ prompt: 'Write a greeting', cwd: work }, HERE, { state: first.saved.at(-1)! });
    expect(await ex.resume!(next.ctx, 'French.')).toEqual({ kind: 'finished', result: { machine: 'local', summary: 'Done in French.', chatId: 'chat-1' } });
    const resumed = calls().at(-1)!;
    expect(resumed.argv.slice(-4)).toEqual(['--resume', 'chat-1', '--', 'French.']);
  });

  it('HOPPER_FAILED fails the job with its reason; an answer without a marker is a question', async () => {
    reply('Tried.\nHOPPER_FAILED the repo is archived');
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }, HERE).ctx)).toEqual({ kind: 'failed', error: 'the repo is archived' });
    reply('I looked at it and stopped.');
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }, HERE).ctx)).toMatchObject({ kind: 'question', question: { text: 'I looked at it and stopped.', detectedBy: 'idle' } });
  });

  it('Cursor failing — not signed in, or an error result — fails the job with what it said', async () => {
    process.env.FAKE_CURSOR_MODE = 'exit1';
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }, HERE).ctx)).toEqual({
      kind: 'failed', error: "cursor-agent exited 1 on local: Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
    });
    process.env.FAKE_CURSOR_MODE = 'error';
    reply('model not available');
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }, HERE).ctx)).toEqual({ kind: 'failed', error: 'cursor-agent on local: model not available' });
  });

  it('runs over ssh on an ssh target, in the same work tree path there', async () => {
    const overSsh = createCursorExecutor({ name: 'cursor', bin: FAKE_CURSOR, args: [], defaultCwd: work, sshBin: FAKE_SSH, sshAuth: testSshAuth(join(dir, 'auth')) });
    reply("It's done.\nHOPPER_DONE");
    expect(await overSsh.run(ctxFor({ prompt: "it's a test" }, LAPTOP).ctx)).toEqual({ kind: 'finished', result: { machine: 'laptop', summary: "It's done.", chatId: 'chat-1' } });
    expect(calls().at(-1)).toMatchObject({ cwd: work, argv: ['-p', '--output-format', 'json', '--workspace', work, '--', expect.stringMatching(/^it's a test\n/)] });
    const ssh = JSON.parse(readFileSync(join(dir, 'ssh-calls.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { argv: string[] };
    expect(ssh.argv.slice(ssh.argv.indexOf('--') + 1, -1)).toEqual(['laptop.example']);
  });

  it('refuses a container target and a client target: Cursor runs only here or over ssh', async () => {
    expect(await ex.run(ctxFor({ prompt: 'p' }, { ...HERE, id: 'box', docker: 'c' }).ctx)).toEqual({ kind: 'failed', error: 'cursor-agent does not run on container target box: it has no agent' });
    expect(await ex.run(ctxFor({ prompt: 'p' }, { ...HERE, id: 'studio', client: { tokenEnv: 'T' } }).ctx)).toEqual({ kind: 'failed', error: 'cursor-agent does not run on client target studio: a client serves herdr only' });
  });

  it('cancel stops Cursor', async () => {
    process.env.FAKE_CURSOR_MODE = 'hang';
    const ac = new AbortController();
    const run = ex.run(ctxFor({ prompt: 'p', cwd: work }, HERE, { signal: ac.signal }).ctx);
    setTimeout(() => ac.abort('cancel'), 200);
    expect(await run).toEqual({ kind: 'failed', error: 'aborted' });
  });

  it('validates a prompt payload, and is not idempotent: a restart never runs an agent twice', () => {
    expect(ex.validate({ prompt: 'do it' })).toBeNull();
    expect(ex.validate({ body: 'do it' })).toMatch(/prompt/);
    expect(ex.idempotent).toBe(false);
  });
});
