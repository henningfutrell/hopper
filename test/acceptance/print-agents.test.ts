// Issue #1958: the real print-mode agent CLIs through the real executors, against the fake model server on loopback
// with a dummy key: no real model call. Each completes a job with a tool call, asks a question and resumes its session,
// and fails cleanly on every fault the server injects. A CLI not installed here skips (test/support/real-agents.ts).
// Cursor's agent is not here: its endpoint cannot be pointed at another server.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionContext, ExecutionOutcome } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createPrintAgentExecutor } from '../../src/executors/index.ts';
import { startFakeModelServer, type FakeModelServer, type ModelFault, type ModelStep } from '../support/fake-model-server.ts';
import { REAL_AGENTS, realBin, writeAgentFiles } from '../support/real-agents.ts';
import { useStandInPodman } from '../support/stand-in-podman.ts';

const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['agent'] };
/** A turn of a real CLI: its start, a few requests to the server, its tools. */
const TURN_MS = 90_000;
const FAULTS: readonly ModelFault[] = ['rate-limited', 'overloaded', 'server-error', 'cut', 'malformed'];
/** A fault's turn: a CLI fails on it in a few seconds, or retries until this timeout ends it. */
const FAULT_TURN_MS = 20_000;

let server: FakeModelServer;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-acceptance-'));
  useStandInPodman(dir);
  delete process.env.HOPPER_URL;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let jobs = 0;
function ctxFor(payload: Record<string, unknown>, state?: Record<string, unknown>) {
  const saved: Record<string, unknown>[] = [];
  const job: Job = {
    id: `job-accept-${process.pid}-${++jobs}`, spec: { executor: 'agent', payload, machineId: HERE.id }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1, ...(state ? { executorState: state } : {}),
  };
  const ctx: ExecutionContext = {
    job, laneId: 'local/lane-1', machine: HERE, signal: new AbortController().signal, progress: () => {}, saveState: (s) => { saved.push(s); }, workTree() {},
  };
  return { ctx, saved };
}

/** The text of every request the server took since `from`, as the CLI sent it. */
const sent = (from: number): string => JSON.stringify(server.requests.slice(from).map((r) => r.body));

describe.each(REAL_AGENTS)('the real $agent CLI', (a) => {
  const bin = realBin(a.agent);
  const absent = !bin;
  const payload = (work: string, timeoutMs = TURN_MS) => ({ prompt: 'Write greeting.txt with a greeting.', cwd: work, model: a.model, timeoutMs, env: a.env(server.url) });
  /** Its executor, with the plugin's arguments that point it at the server. */
  const withArgs = () => createPrintAgentExecutor({ agent: a.agent, name: a.agent, bin: bin!, args: a.args(server.url), sshAuth: () => { throw new Error('no ssh'); } });
  const work = (name: string) => join(dir, `${a.agent}-${name}`);

  // A server of its own (issue #2856): a CLI a timed-out turn left running (opencode 2's run and its server, until
  // the job's reap) still asks its server, and would take the steps of the next CLI's script.
  beforeAll(async () => {
    server = await startFakeModelServer();
    if (bin) writeAgentFiles(a, server.url);
  });
  afterAll(async () => { await server.close(); });

  it.skipIf(absent)('completes a job: a tool call writes the file, the last message ends with HOPPER_DONE', async () => {
    server.script([a.write('greeting.txt', 'Hello'), { text: 'I wrote greeting.txt.\n\nHOPPER_DONE' }]);
    const from = server.requests.length;
    const cwd = work('done');
    const out = await withArgs().run(ctxFor(payload(cwd)).ctx);
    expect(out).toMatchObject({ kind: 'finished', result: { machine: 'local', summary: 'I wrote greeting.txt.' } });
    expect(readFileSync(join(cwd, 'greeting.txt'), 'utf8')).toBe('Hello');
    expect(server.left()).toBe(0);
    // The hopper's protocol reached the model with the prompt.
    expect(sent(from)).toContain('HOPPER_QUESTION');
  }, TURN_MS * 2);

  it.skipIf(absent)('asks a question, and the answer resumes the same session', async () => {
    const cwd = work('question');
    server.script([{ text: 'Which language should the greeting be in?\nHOPPER_QUESTION' }]);
    const first = ctxFor(payload(cwd));
    const asked = await withArgs().run(first.ctx);
    expect(asked).toMatchObject({ kind: 'question', question: { text: 'Which language should the greeting be in?', detectedBy: 'marker' } });
    const state = first.saved.at(-1)!;
    expect(state.chatId).toEqual(expect.any(String));

    server.script([a.write('greeting.txt', 'Hallo'), { text: 'Done in German.\n\nHOPPER_DONE' }]);
    const from = server.requests.length;
    const resumed = await withArgs().resume!(ctxFor(payload(cwd), state).ctx, 'German, please.');
    expect(resumed).toMatchObject({ kind: 'finished', result: { summary: 'Done in German.' } });
    // The session's history came back with the answer: the CLI resumed it, not a new one.
    expect(sent(from)).toContain('Which language should the greeting be in?');
    expect(sent(from)).toContain('German, please.');
    expect(readFileSync(join(cwd, 'greeting.txt'), 'utf8')).toBe('Hallo');
  }, TURN_MS * 3);

  describe.each(FAULTS)('on %s', (fault) => {
    const retries = a.retriesPastTimeout?.includes(fault) ?? false;
    const either = a.eitherWay?.includes(fault) ?? false;
    const title = either ? 'the job fails, at once or at the turn\'s timeout, with no answer made up'
      : retries ? 'the CLI retries until the turn\'s timeout fails the job' : 'the job fails at once, with no answer made up';
    it.skipIf(absent)(title, async () => {
      // The fault at every turn: a CLI that retries meets it again.
      server.script(Array.from({ length: 12 }, (): ModelStep => ({ fault, text: 'I wrote greeting.txt.\n\nHOPPER_DONE' })));
      const cwd = work(`fault-${fault}`);
      const from = server.requests.length;
      const out: ExecutionOutcome = await withArgs().run(ctxFor(payload(cwd, FAULT_TURN_MS)).ctx);
      expect(out.kind).toBe('failed');
      // Which way it failed is the CLI's retry behaviour: a change in it shows here.
      if (!either) expect(out.kind === 'failed' && out.error).toSatisfy((e: string) => /timed out after/.test(e) === retries);
      // It failed on the fault: the CLI reached the server.
      expect(server.requests.slice(from).some((r) => r.step)).toBe(true);
      expect(existsSync(join(cwd, 'greeting.txt'))).toBe(false);
    }, FAULT_TURN_MS * 2);
  });
});
