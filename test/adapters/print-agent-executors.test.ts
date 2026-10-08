// Issue #307: every agent box runs jobs, so codex, opencode and omp have executors, as Cursor's agent
// does (issue #142): the agent's CLI in print mode on the job's machine, in the job's work tree, one run
// per turn; the hopper protocol's marker on its last message decides done, a question (answered by
// resuming the same session) or failed (design.md "Print-mode agent executors"). The CLIs are stand-ins
// that print the JSON events each real one prints.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createPrintAgentExecutor, type PrintAgent } from '../../src/executors/index.ts';
import { STATUS_NOTE_NUDGE } from '../../src/executors/herdr/index.ts';
import { userSystemd } from '../support/systemd.ts';

const FAKE = join(import.meta.dirname, 'fake-print-agent.mjs');
// Its own per run: the job's TMPDIR is a link in /tmp named for the job id (issue #506), and runs share /tmp.
const ID = `job-print-${process.pid}`;
const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['agent'] };
let dir: string;
let work: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-print-agent-'));
  work = join(dir, 'work');
  process.env.FAKE_AGENT_DIR = dir;
  // A job's credential reaches the agent only from the hopper, never from the environment the tests run in.
  delete process.env.GH_TOKEN;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_REPLIES;
  rmSync(join(dir, 'agent-calls.jsonl'), { force: true });
});

interface Call { argv: string[]; cwd: string; env: Record<string, string | undefined> }
const calls = (): Call[] => readFileSync(join(dir, 'agent-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call);
const reply = (text: string) => { process.env.FAKE_AGENT_REPLY = text; };

function ctxFor(payload: Record<string, unknown>, o: { state?: Record<string, unknown>; signal?: AbortSignal; credentials?: Record<string, string> } = {}) {
  const saved: Record<string, unknown>[] = [];
  const job: Job = {
    id: ID, spec: { executor: 'agent', payload, machineId: HERE.id }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1, ...(o.state ? { executorState: o.state } : {}),
  };
  const ctx: ExecutionContext = {
    job, laneId: 'local/lane-1', machine: HERE, signal: o.signal ?? new AbortController().signal, progress() {}, saveState: (s) => { saved.push(s); },
    workTree() {}, ...(o.credentials ? { credentials: async () => o.credentials! } : {}),
  };
  return { ctx, saved };
}

/** Per agent: its arguments in the test, how a first turn and a resumed turn call its CLI, and its session id. */
const AGENTS: { agent: PrintAgent; args: string[]; first: (model: string) => string[]; resumed: (id: string) => string[]; session: string; error: string }[] = [
  {
    agent: 'codex', args: ['--skip-git-repo-check'], session: 'thread-1',
    first: (m) => ['exec', '--json', '--skip-git-repo-check', '--model', m, '--'],
    resumed: (id) => ['exec', 'resume', '--json', '--skip-git-repo-check', '--', id],
    error: 'codex exited 1 on local: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
  },
  {
    agent: 'opencode', args: ['--auto'], session: 'ses_1',
    first: (m) => ['run', '--format', 'json', '--auto', '--model', m, '--'],
    resumed: (id) => ['run', '--format', 'json', '--auto', '--session', id, '--'],
    error: 'opencode exited 1 on local: APIError: Not Found',
  },
  {
    agent: 'omp', args: ['--auto-approve'], session: 'omp-session-1',
    first: (m) => ['-p', '--mode', 'json', '--no-title', '--auto-approve', '--model', m, '--'],
    resumed: (id) => ['-p', '--mode', 'json', '--no-title', '--auto-approve', '--resume', id, '--'],
    error: 'omp on local: No API key found for anthropic',
  },
];

describe.each(AGENTS)('the $agent executor', ({ agent, args, first, resumed, session, error }) => {
  const noSsh = () => { throw new Error('no ssh in this test'); };
  const ex = createPrintAgentExecutor({ agent, name: agent, bin: FAKE, args, sshAuth: noSsh });
  beforeEach(() => { process.env.FAKE_AGENT_KIND = agent; });

  it('runs the CLI in print mode in the job\'s work tree, with the protocol after the prompt and the job\'s GitHub credential, and finishes on HOPPER_DONE', async () => {
    reply('I wrote greeting.txt.\n\nHOPPER_DONE');
    const out = await ex.run(ctxFor({ prompt: 'Write a greeting', cwd: work, env: { HOPPER_REPO: 'o/r' }, model: 'm-1' }, { credentials: { GH_TOKEN: 'gho_job' } }).ctx);
    expect(out).toEqual({ kind: 'finished', result: { machine: 'local', summary: 'I wrote greeting.txt.', chatId: session } });
    const [call] = calls();
    expect(call!.cwd).toBe(work);
    expect(call!.env).toEqual({ TMPDIR: `/tmp/hopper-${ID}`, HOPPER_JOB_ID: ID, HOPPER_REPO: 'o/r', GH_TOKEN: 'gho_job' });
    expect(call!.argv.slice(0, -1)).toEqual(first('m-1'));
    expect(call!.argv.at(-1)).toMatch(/^Write a greeting\n\n\[hopper publishing rule\][\s\S]*HOPPER_FAILED followed by the reason\.$/);
  });

  it('a question pauses the job with its session; the answer resumes that session', async () => {
    reply('Which language should it be in?\nHOPPER_QUESTION');
    const firstTurn = ctxFor({ prompt: 'Write a greeting', cwd: work });
    expect(await ex.run(firstTurn.ctx)).toEqual({
      kind: 'question', question: { text: 'Which language should it be in?', recentOutput: 'Which language should it be in?\nHOPPER_QUESTION', detectedBy: 'marker' },
    });
    expect(firstTurn.saved.at(-1)).toEqual({ chatId: session, cwd: work });
    reply('Done in French.\nHOPPER_DONE');
    const next = ctxFor({ prompt: 'Write a greeting', cwd: work }, { state: firstTurn.saved.at(-1)! });
    expect(await ex.resume!(next.ctx, 'French.')).toEqual({ kind: 'finished', result: { machine: 'local', summary: 'Done in French.', chatId: session } });
    expect(calls().at(-1)!.argv).toEqual([...resumed(session), 'French.']);
  });

  it('HOPPER_FAILED fails the job with its reason', async () => {
    reply('Tried.\nHOPPER_FAILED the repo is archived');
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }).ctx)).toEqual({ kind: 'failed', error: 'the repo is archived' });
  });

  it('an answer without a marker is a status note: nudged in the same session, at most three times', async () => {
    process.env.FAKE_AGENT_REPLIES = JSON.stringify(['I will now write the file.', 'Wrote it.\nHOPPER_DONE']);
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }).ctx)).toMatchObject({ kind: 'finished', result: { summary: 'Wrote it.' } });
    expect(calls().at(-1)!.argv).toEqual([...resumed(session), STATUS_NOTE_NUDGE]);
    delete process.env.FAKE_AGENT_REPLIES;
    reply('Still thinking.');
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }).ctx)).toEqual({ kind: 'failed', error: `${agent} answered 4 times in a row without a marker: Still thinking.` });
  });

  it('the CLI\'s own error — not signed in, no model — fails the job with what it said', async () => {
    process.env.FAKE_AGENT_MODE = 'error';
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }).ctx)).toEqual({ kind: 'failed', error });
  });

  it('cancel stops the CLI', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    const ac = new AbortController();
    const run = ex.run(ctxFor({ prompt: 'p', cwd: work }, { signal: ac.signal }).ctx);
    setTimeout(() => ac.abort('cancel'), 200);
    expect(await run).toEqual({ kind: 'failed', error: 'aborted' });
  });

  it.each([
    ['a process that left its session', 'leave', true],
    ['a process that cleared its environment too (in the job\'s scope)', 'escape', userSystemd],
  ] as const)('leaves nothing behind (issue #410): its own scratch dir, and the reap at its end stops %s and removes the dir', async (_what, mode, runs) => {
    if (!runs) return;
    const leftover = `jh-410-${agent}-${mode}-${process.pid}`;
    process.env.FAKE_AGENT_MODE = mode;
    process.env.FAKE_AGENT_LEFTOVER = leftover;
    reply('Done.\n\nHOPPER_DONE');
    const { ctx, saved } = ctxFor({ prompt: 'p', cwd: work });
    expect(await ex.run(ctx)).toMatchObject({ kind: 'finished' });
    const scratch = `${work}/.hopper-scratch/${ID}`;
    expect(existsSync(`${scratch}/left.txt`)).toBe(true);
    expect(readlinkSync(`/tmp/hopper-${ID}`)).toBe(scratch);
    expect(saved[0]).toEqual({ cwd: work });
    const running = (): boolean => spawnSync('pgrep', ['-f', leftover]).status === 0;
    try {
      expect(running()).toBe(true);
      const job = { ...ctx.job, status: 'finished' as const, executorState: saved.at(-1)! };
      expect(await ex.cleanup!(job)).toEqual({ kept: [] });
      expect(running()).toBe(false);
      expect(existsSync(scratch)).toBe(false);
      expect(() => lstatSync(`/tmp/hopper-${ID}`)).toThrow();
    } finally {
      spawnSync('pkill', ['-f', leftover]);
    }
  });

  it('reaches this machine and ssh targets for the sweep, never a container or a client target (issue #410)', () => {
    expect(ex.machineShell!(HERE)).toBeDefined();
    expect(ex.machineShell!({ ...HERE, ssh: 'box' })).toBeDefined();
    expect(ex.machineShell!({ ...HERE, docker: 'c' })).toBeUndefined();
    expect(ex.machineShell!({ ...HERE, client: {} })).toBeUndefined();
  });

  it('refuses a container target and a client target, and is not idempotent', async () => {
    expect(await ex.run({ ...ctxFor({ prompt: 'p' }).ctx, machine: { ...HERE, id: 'box', docker: 'c' } })).toEqual({ kind: 'failed', error: `${agent} does not run on container target box: it has no agent` });
    expect(ex.idempotent).toBe(false);
  });
});
