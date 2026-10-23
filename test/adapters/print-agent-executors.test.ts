// Issue #307: every agent box runs jobs, so codex, opencode and omp have executors (and, issue #533, Claude Code), as Cursor's agent
// does (issue #142): the agent's CLI in print mode on the job's machine, in the job's work tree, one run
// per turn; the hopper protocol's marker on its last message decides done, a question (answered by
// resuming the same session) or failed (design.md "Print-mode agent executors"). The CLIs are stand-ins
// that print the JSON events each real one prints.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import type { TaskCount } from '../../src/domain/task-count.ts';
import type { SessionTokenUse } from '../../src/domain/token-usage.ts';
import { createPrintAgentExecutor, type PrintAgent } from '../../src/executors/index.ts';
import { STATUS_NOTE_NUDGE } from '../../src/executors/herdr/index.ts';
import { userSystemd } from '../support/systemd.ts';
import { withoutUse } from '../support/reap-said.ts';
import { useStandInPodman } from '../support/stand-in-podman.ts';

const FAKE = join(import.meta.dirname, 'fake-print-agent.mjs');
// Its own per run: the job's TMPDIR is a link in /tmp named for the job id (issue #506), and runs share /tmp.
const ID = `job-print-${process.pid}`;
const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['agent'] };
let dir: string;
let work: string;

/** Whether bubblewrap runs here as the job's sandbox needs it (issue #1295): where it cannot, a turn runs as before. */
const bwrapRuns = spawnSync('bwrap', ['--dev-bind', '/', '/', '--proc', '/proc', '--unshare-pid', '--unshare-ipc', '--die-with-parent', 'true']).status === 0;
/** The job's socket service, while it runs: its stand-in, named by its socket. */
const socketRuns = (): boolean => spawnSync('pgrep', ['-f', `hopper-runtime-${ID}/podman/podman.sock`]).status === 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-print-agent-'));
  work = join(dir, 'work');
  process.env.FAKE_AGENT_DIR = dir;
  useStandInPodman(dir);
  // A job's credential reaches the agent only from the hopper, never from the environment the tests run in.
  delete process.env.HOPPER_URL;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_AGENT_REPLIES;
  rmSync(join(dir, 'agent-calls.jsonl'), { force: true });
});

interface Call { argv: string[]; cwd: string; env: Record<string, string | undefined>; sandbox: { sandboxed?: string; containerHost?: string; pid: number } }
const calls = (): Call[] => readFileSync(join(dir, 'agent-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call);
const reply = (text: string) => { process.env.FAKE_AGENT_REPLY = text; };

function ctxFor(payload: Record<string, unknown>, o: { state?: Record<string, unknown>; signal?: AbortSignal; credentials?: Record<string, string> } = {}) {
  const saved: Record<string, unknown>[] = [];
  const progress: { message?: string; tasks?: TaskCount }[] = [];
  const tokens: { session: string; use: SessionTokenUse }[] = [];
  const job: Job = {
    id: ID, spec: { executor: 'agent', payload, machineId: HERE.id }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1, ...(o.state ? { executorState: o.state } : {}),
  };
  const ctx: ExecutionContext = {
    job, laneId: 'local/lane-1', machine: HERE, signal: o.signal ?? new AbortController().signal, progress: (message, tasks) => { progress.push({ message, tasks }); }, saveState: (s) => { saved.push(s); },
    workTree() {}, ...(o.credentials ? { credentials: async () => o.credentials! } : {}), tokenUse: (session, use) => { tokens.push({ session, use }); },
  };
  return { ctx, saved, progress, tokens };
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
  {
    // Issue #533: Claude Code in print mode, never shows a screen: nothing to answer in a fresh home.
    agent: 'claude', args: ['--dangerously-skip-permissions'], session: 'claude-session-1',
    first: (m) => ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', m, '--'],
    resumed: (id) => ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--resume', id, '--'],
    error: 'claude exited 1 on local: Invalid API key · Fix external API key',
  },
];

// Issue #2302, part 6: a print-mode Claude turn keeps no agent session the checkpoint reads; its JSON result's
// modelUsage is what the turn spent, kept in the token ledger by its session.
describe('the claude executor\'s token use', () => {
  const ex = createPrintAgentExecutor({ agent: 'claude', name: 'claude', bin: FAKE, args: [], sshAuth: () => { throw new Error('no ssh in this test'); } });
  beforeEach(() => { process.env.FAKE_AGENT_KIND = 'claude'; });

  it('reports each turn\'s use, by its session, with when the turn ran', async () => {
    reply('Which colour?\nHOPPER_QUESTION');
    const t = ctxFor({ prompt: 'Paint it', cwd: work });
    const before = new Date().toISOString();
    expect((await ex.run(t.ctx)).kind).toBe('question');
    expect(t.tokens).toEqual([{ session: 'claude-session-1', use: { models: [{ model: 'claude-opus-5-5', turns: 2, input: 3, output: 30, cacheRead: 300, cacheWrite: 20 }], first: expect.any(String), last: expect.any(String) } }]);
    expect(t.tokens[0]!.use.first! >= before && t.tokens[0]!.use.last! >= t.tokens[0]!.use.first!).toBe(true);
  });
});

describe.each(AGENTS)('the $agent executor', ({ agent, args, first, resumed, session, error }) => {
  const noSsh = () => { throw new Error('no ssh in this test'); };
  const ex = createPrintAgentExecutor({ agent, name: agent, bin: FAKE, args, sshAuth: noSsh });
  beforeEach(() => { process.env.FAKE_AGENT_KIND = agent; });

  it('runs the CLI in print mode in the job\'s work tree, with the protocol after the prompt and the job\'s way to the hopper, and finishes on HOPPER_DONE', async () => {
    reply('I wrote greeting.txt.\n\nHOPPER_DONE');
    const out = await ex.run(ctxFor({ prompt: 'Write a greeting', cwd: work, env: { HOPPER_REPO: 'o/r' }, model: 'm-1' }, { credentials: { HOPPER_URL: 'http://hopper.test' } }).ctx);
    expect(out).toEqual({ kind: 'finished', result: { machine: 'local', summary: 'I wrote greeting.txt.', chatId: session } });
    const [call] = calls();
    expect(call!.cwd).toBe(work);
    expect(call!.env).toEqual({ TMPDIR: `/tmp/hopper-${ID}`, HOPPER_JOB_ID: ID, CHECKPOINT_DISABLE: '1', GRADLE_OPTS: '-Dorg.gradle.daemon.idletimeout=300000', HOPPER_REPO: 'o/r', HOPPER_URL: 'http://hopper.test' });
    expect(call!.argv.slice(0, -1)).toEqual(first('m-1'));
    expect(call!.argv.at(-1)).toMatch(/^Write a greeting\n\n\[hopper publishing rule\][\s\S]*HOPPER_FAILED followed by the reason\.$/);
  });

  // Issue #794: the last task count the turn wrote is the job's progress.
  it('reports the last task count the turn wrote', async () => {
    reply('Wrote the test.\nHOPPER_TASKS 1/2\nWrote greeting.txt.\nHOPPER_TASKS 2/2\n\nHOPPER_DONE');
    const t = ctxFor({ prompt: 'Write a greeting', cwd: work });
    expect((await ex.run(t.ctx)).kind).toBe('finished');
    expect(t.progress.filter((p) => p.tasks).map((p) => p.tasks)).toEqual([{ done: 2, total: 2 }]);
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

  // Issue #1472 part 2: Push it continues the ended job; with no pane to park, a fresh turn starts in its saved work tree.
  it('a job continued to push its kept work starts a fresh turn in its saved work tree, its task first, never its old session', async () => {
    expect(ex.reopensKept).toBe(true);
    reply('Pushed the branch.\nHOPPER_DONE');
    const t = ctxFor({ prompt: 'Write a greeting', cwd: join(dir, 'elsewhere') }, { state: { cwd: work, chatId: session } });
    t.ctx.job.continued = { at: '', keptWork: true };
    expect(await ex.resume!(t.ctx, 'Push the kept work.')).toEqual({ kind: 'finished', result: { machine: 'local', summary: 'Pushed the branch.', chatId: session } });
    const call = calls().at(-1)!;
    expect(call.cwd).toBe(work);
    expect(call.argv.slice(0, -1)).toEqual(first('m-1').filter((a, i, all) => a !== 'm-1' && all[i + 1] !== 'm-1'));
    expect(call.argv.at(-1)).toMatch(/^Write a greeting\n\nPush the kept work\.\n\n\[hopper publishing rule\]/);
  });

  // Issue #1295: a turn's agent runs as Claude does in a pane, in the job's sandbox, with podman a client of the job's
  // socket; that socket runs in the turn's scope only while the agent runs.
  it('runs the CLI in the job\'s sandbox, with the job\'s socket started for the turn and stopped when it ends', async () => {
    reply('Done.\n\nHOPPER_DONE');
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: work }).ctx)).toMatchObject({ kind: 'finished' });
    const [call] = calls();
    if (bwrapRuns) {
      expect(call!.sandbox).toMatchObject({ sandboxed: '1', containerHost: expect.stringMatching(new RegExp(`^unix:///.*/hopper-runtime-${ID}/podman/podman\\.sock$`)) });
      // Its own PID namespace: the agent is one of the first processes in it.
      expect(call!.sandbox.pid).toBeLessThan(10);
    } else {
      expect(call!.sandbox.sandboxed).toBeUndefined();
      expect(call!.sandbox.containerHost).toBeUndefined();
    }
    expect(socketRuns()).toBe(false);
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
    const scratch = `${work}/.worktrees/@scratch/${ID}`;
    expect(existsSync(`${scratch}/left.txt`)).toBe(true);
    expect(readlinkSync(`/tmp/hopper-${ID}`)).toBe(scratch);
    expect(saved[0]).toEqual({ cwd: work });
    const running = (): boolean => spawnSync('pgrep', ['-f', leftover]).status === 0;
    try {
      // The CLI ends as soon as it spawned the leftover; its exec under its name can come a moment later. In the job's
      // sandbox (issue #1295), its PID namespace ends with the turn, and the leftover with it.
      if (bwrapRuns) await vi.waitFor(() => expect(running()).toBe(false), { timeout: 5000 });
      else await vi.waitFor(() => expect(running()).toBe(true), { timeout: 5000 });
      const job = { ...ctx.job, status: 'finished' as const, executorState: saved.at(-1)! };
      // Where the turn ran in the job's scope, which the leftover keeps up, the reap says what it used too (issue #2498); the
      // disk of its scratch dir always (part 4).
      const said = await ex.cleanup!(job);
      expect(withoutUse(said)).toEqual({ kept: [] });
      expect(running()).toBe(false);
      expect(existsSync(scratch)).toBe(false);
      expect(() => lstatSync(`/tmp/hopper-${ID}`)).toThrow();
    } finally {
      spawnSync('pkill', ['-f', leftover]);
    }
  });

  it('reaches this machine, ssh targets and client targets (issue #865) for the sweep, never a container (issue #410)', () => {
    expect(ex.machineShell!(HERE)).toBeDefined();
    expect(ex.machineShell!({ ...HERE, ssh: 'box' })).toBeDefined();
    expect(ex.machineShell!({ ...HERE, containerImage: 'c' })).toBeUndefined();
    expect(ex.machineShell!({ ...HERE, client: {} })).toBeDefined();
  });

  it('refuses a container target, and is not idempotent', async () => {
    expect(await ex.run({ ...ctxFor({ prompt: 'p' }).ctx, machine: { ...HERE, id: 'box', containerImage: 'c' } })).toEqual({ kind: 'failed', error: `${agent} does not run on container target box: it has no agent` });
    expect(ex.idempotent).toBe(false);
  });
});
