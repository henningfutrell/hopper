// Issue #1958: an agent CLI that misbehaves fails its job cleanly, or its answer still reads — never a hang, a crash
// or an answer made up. The stand-in prints each fault in each CLI's own shape ($FAKE_AGENT_MODE, fake-print-agent.mjs):
// a partial stream then a hang, a malformed line, an interactive permission prompt, huge output, output that is not
// UTF-8, and an exit with no final event.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext, ExecutionOutcome } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { createPrintAgentExecutor, type PrintAgent } from '../../src/executors/index.ts';
import { useStandInPodman } from '../support/stand-in-podman.ts';

const FAKE = join(import.meta.dirname, 'fake-print-agent.mjs');
const ID = `job-print-fault-${process.pid}`;
const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['agent'] };
/** The turn's timeout in these tests: a hang ends with it. */
const TIMEOUT_MS = 3000;
let dir: string;
let work: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-print-fault-'));
  work = join(dir, 'work');
  process.env.FAKE_AGENT_DIR = dir;
  useStandInPodman(dir);
  delete process.env.HOPPER_URL;
});
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
beforeEach(() => {
  delete process.env.FAKE_AGENT_REPLIES;
  delete process.env.FAKE_AGENT_HUGE_MB;
  process.env.FAKE_AGENT_REPLY = 'I wrote greeting.txt.\n\nHOPPER_DONE';
  rmSync(join(dir, 'agent-calls.jsonl'), { force: true });
});

function ctx(): ExecutionContext {
  const job: Job = {
    id: ID, spec: { executor: 'agent', payload: { prompt: 'p', cwd: work, timeoutMs: TIMEOUT_MS }, machineId: HERE.id }, priority: 50,
    status: 'running', approved: false, createdAt: '', updatedAt: '', attempts: 1,
  };
  return { job, laneId: 'local/lane-1', machine: HERE, signal: new AbortController().signal, progress() {}, saveState() {}, workTree() {} };
}

const AGENTS: readonly PrintAgent[] = ['codex', 'opencode', 'omp', 'claude'];

describe.each(AGENTS)('the %s executor, on a CLI that misbehaves', (agent) => {
  const ex = createPrintAgentExecutor({ agent, name: agent, bin: FAKE, args: [], sshAuth: () => { throw new Error('no ssh'); } });
  const runIn = async (mode: string): Promise<ExecutionOutcome> => {
    process.env.FAKE_AGENT_KIND = agent;
    process.env.FAKE_AGENT_MODE = mode;
    try { return await ex.run(ctx()); } finally { delete process.env.FAKE_AGENT_MODE; }
  };

  it('a partial stream, then a hang: the turn\'s timeout fails the job', async () => {
    expect(await runIn('partial-hang')).toEqual({ kind: 'failed', error: `${agent} on local timed out after ${TIMEOUT_MS} ms` });
  }, TIMEOUT_MS * 4);

  it('a malformed line: an event stream skips it and reads the answer; claude\'s one result that is not JSON fails the job', async () => {
    const out = await runIn('malformed');
    if (agent === 'claude') expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^claude on local printed no JSON result: \{"type":"result"/) });
    else expect(out).toMatchObject({ kind: 'finished', result: { summary: 'I wrote greeting.txt.' } });
  });

  it('an interactive permission prompt: with no terminal to answer it, the job fails with what the CLI said', async () => {
    expect(await runIn('permission-prompt')).toEqual({
      kind: 'failed', error: `${agent} exited 1 on local: Error: the permission prompt needs a terminal: Allow the command \`rm -rf build\`? [y/N]`,
    });
  });

  it('huge output: the answer still reads, its summary capped', async () => {
    process.env.FAKE_AGENT_HUGE_MB = '8';
    const out = await runIn('huge');
    expect(out.kind).toBe('finished');
    const summary = out.kind === 'finished' ? (out.result as { summary: string }).summary : '';
    expect(summary.length).toBeLessThanOrEqual(2000);
    if (agent !== 'claude') expect(summary).toBe('I wrote greeting.txt.');
  }, 30_000);

  it('output past the run\'s buffer: the job fails and says so', async () => {
    process.env.FAKE_AGENT_HUGE_MB = '70';
    expect(await runIn('huge')).toEqual({ kind: 'failed', error: `${agent} on local: printed more than 64 MiB` });
  }, 60_000);

  it('output that is not UTF-8: the bad bytes read as replacement characters, and the answer still reads', async () => {
    expect(await runIn('non-utf8')).toMatchObject({ kind: 'finished', result: { summary: 'I wrote gr�(eeting.txt.' } });
  });

  it('an exit with no final event: the job fails, with no answer made up', async () => {
    const out = await runIn('no-final');
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error).toMatch(agent === 'claude' ? /^claude on local printed no JSON result: $/ : new RegExp(`^${agent} on local answered no message$`));
  });
});
