// Issue #865 part A: a client target runs every executor, not only herdr-claude. A print-mode agent's turn goes down the
// machine's link as one signed `POST /turn`: the client runs the turn the hopper built, the job's own runtime and sandbox
// around the agent as on this machine, and answers what it printed. Cancel closes the call, and the client stops the turn.
// The reap goes through the client's `/reap`. The client is real; the hopper's end is a loopback server.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mintToken } from '../../src/client/signature.ts';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { clientTurn } from '../../src/executors/client.ts';
import { createPrintAgentExecutor } from '../../src/executors/index.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { withoutUse } from '../support/reap-said.ts';
import { useStandInPodman } from '../support/stand-in-podman.ts';

const FAKE = join(import.meta.dirname, 'fake-print-agent.mjs');
const ID = `job-turn-${process.pid}`;
const TOKEN = mintToken();
let dir: string;
let work: string;
let client: TestClient;
const STUDIO = (): MachineSnapshot => ({ id: 'studio', label: 'studio', maxLanes: 1, online: true, executors: ['codex'], client: {}, home: dir });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-print-client-'));
  work = join(dir, 'work');
  process.env.FAKE_AGENT_DIR = dir;
  process.env.FAKE_AGENT_KIND = 'codex';
  useStandInPodman(dir);
  delete process.env.HOPPER_URL;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  delete process.env.FAKE_AGENT_MODE;
  rmSync(join(dir, 'agent-calls.jsonl'), { force: true });
  client = await startTestClient({ token: () => TOKEN, herdrBin: '/bin/false', session: 'hopper' });
});
afterEach(async () => { await client.stop(); });

const calls = (): { argv: string[]; cwd: string }[] => readFileSync(join(dir, 'agent-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string });

function ctxFor(payload: Record<string, unknown>, signal = new AbortController().signal) {
  const saved: Record<string, unknown>[] = [];
  const job: Job = {
    id: ID, spec: { executor: 'codex', payload, machineId: 'studio' }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1,
  };
  const ctx: ExecutionContext = { job, laneId: 'studio/lane-1', machine: STUDIO(), signal, progress() {}, saveState: (s) => { saved.push(s); }, workTree() {} };
  return { ctx, saved };
}

const executor = () => createPrintAgentExecutor({
  agent: 'codex', name: 'codex', bin: FAKE, args: [], sshAuth: () => { throw new Error('no ssh in this test'); },
  client: (machine) => (machine === 'studio' ? client.transport(TOKEN) : undefined),
});

describe('a print-mode agent on a client target', () => {
  it('runs its turn on the client, in the job\'s work tree, and finishes on HOPPER_DONE', async () => {
    process.env.FAKE_AGENT_REPLY = 'Wrote it.\n\nHOPPER_DONE';
    const { ctx, saved } = ctxFor({ prompt: 'Write a greeting', cwd: '~/work' });
    expect(await executor().run(ctx)).toEqual({ kind: 'finished', result: { machine: 'studio', summary: 'Wrote it.', chatId: 'thread-1' } });
    expect(calls()[0]!.cwd).toBe(work);
    expect(saved[0]).toEqual({ cwd: work, client: 'studio' });
  });

  it('a question keeps the session, and the answer resumes it on the client', async () => {
    process.env.FAKE_AGENT_REPLY = 'Which language?\nHOPPER_QUESTION';
    const first = ctxFor({ prompt: 'p', cwd: '~/work' });
    const ex = executor();
    expect(await ex.run(first.ctx)).toMatchObject({ kind: 'question' });
    process.env.FAKE_AGENT_REPLY = 'Done.\nHOPPER_DONE';
    const next = ctxFor({ prompt: 'p', cwd: '~/work' });
    next.ctx.job.executorState = first.saved.at(-1)!;
    expect(await ex.resume!(next.ctx, 'French.')).toMatchObject({ kind: 'finished' });
    expect(calls().at(-1)!.argv.at(-1)).toBe('French.');
  });

  it('cancel closes the call, and the client stops the turn', async () => {
    process.env.FAKE_AGENT_MODE = 'hang';
    const ac = new AbortController();
    const run = executor().run(ctxFor({ prompt: 'p', cwd: '~/work' }, ac.signal).ctx);
    setTimeout(() => ac.abort('cancel'), 300);
    expect(await run).toEqual({ kind: 'failed', error: 'aborted' });
  });

  it('a machine whose client is not dialled in fails the job and says so', async () => {
    const ex = createPrintAgentExecutor({ agent: 'codex', name: 'codex', bin: FAKE, args: [], sshAuth: () => { throw new Error('no ssh'); }, client: () => undefined });
    expect(await ex.run(ctxFor({ prompt: 'p', cwd: '~/work' }).ctx)).toEqual({ kind: 'failed', error: 'codex on studio: client studio is not dialled in' });
  });

  it('the reap runs through the client, and the sweep reaches the machine', async () => {
    process.env.FAKE_AGENT_REPLY = 'Done.\nHOPPER_DONE';
    const ex = executor();
    const { ctx, saved } = ctxFor({ prompt: 'p', cwd: '~/work' });
    expect(await ex.run(ctx)).toMatchObject({ kind: 'finished' });
    const scratch = `${work}/.worktrees/@scratch/${ID}`;
    expect(existsSync(scratch)).toBe(true);
    expect(withoutUse(await ex.cleanup!({ ...ctx.job, status: 'finished', executorState: saved.at(-1)! }))).toEqual({ kept: [] });
    expect(existsSync(scratch)).toBe(false);
    expect(ex.machineShell!(STUDIO())).toBeDefined();
  });
});

describe('the client\'s /turn', () => {
  it('runs the script it is given and answers its output and exit code', async () => {
    expect(await clientTurn(client.transport(TOKEN), 'echo out; echo err >&2; exit 3', 10000, new AbortController().signal)).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  it('stops the turn at its timeout: exit 124', async () => {
    const r = await clientTurn(client.transport(TOKEN), 'sleep 30', 300, new AbortController().signal);
    expect(r).toMatchObject({ code: 124, timedOut: true });
  });

  it('refuses a hopper with the wrong token: the script never runs', async () => {
    const mark = join(dir, 'ran');
    await expect(clientTurn(client.transport(mintToken()), `touch ${mark}`, 10000, new AbortController().signal)).rejects.toThrow(/refused the hopper \(401\)/);
    expect(existsSync(mark)).toBe(false);
  });
});
