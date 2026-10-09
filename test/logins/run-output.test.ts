// Issue #476: a print-mode run — an escalation level's claude, an agent CLI run by an executor — that prints a
// device code reports a login while it waits, never a question or an answer; the run's end completes or fails it,
// and the code never leaves the run in an error.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnswerRequest, EscalationLevel, ExecutionContext, RunLogins } from '../../src/domain/ports.ts';
import type { Job, LoginReport, MachineSnapshot, Question } from '../../src/domain/types.ts';
import { createPrintAgentExecutor } from '../../src/executors/index.ts';
import claudeCli from '../../src/plugins/escalation-level/claude-cli/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { fixedClock } from '../plugins/support.ts';

const HERE: MachineSnapshot = { id: 'local', label: 'here', maxLanes: 1, online: true, executors: ['agent'] };
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-logins-'));
  process.env.FAKE_AGENT_DIR = dir;
  process.env.FAKE_CLAUDE_OUT = join(dir, 'claude.json');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_AGENT_MODE;
  delete process.env.FAKE_CLAUDE_MODE;
});

/** A recording RunLogins. */
function recorder() {
  const reports: { report: LoginReport; renewable: boolean }[] = [];
  const ends: string[] = [];
  const logins: RunLogins = {
    report: (report, o) => { reports.push({ report, renewable: o.renewable }); return 'l1'; },
    check: () => ({ act: 'wait' }),
    completed: (id) => { ends.push(`${id} completed`); },
    expired: (id) => { ends.push(`${id} expired`); },
    failed: (id, reason) => { ends.push(`${id} failed: ${reason}`); },
  };
  return { logins, reports, ends };
}

describe('an escalation level run (claude-cli) that waits on a login', () => {
  const question = { id: 'q1', jobId: 'j1', text: 'Which database?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'opus', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '' } as Question;
  const req = (logins: RunLogins): AnswerRequest => ({ question, jobPrompt: 'p', rules: '', previous: [], level: { number: 1, of: 1 }, logins });
  const ctx = {
    clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: '', userEnv: {}, secretName: (n: string) => n, scratchDir: '', instanceName: 'opus',
    env: (): string | undefined => undefined, machine: async () => HERE, machines: async () => [HERE], escalationMachine: () => undefined, client: () => undefined,
  };
  const level = () => {
    const p = parseOptions(claudeCli, { bin: join(import.meta.dirname, '../plugins/fake-claude.mjs'), timeoutMs: 5000, machine: 'local' });
    if (!p.ok) throw new Error(p.error);
    return claudeCli.create({ ...ctx, dataDir: dir, scratchDir: join(dir, 's') }, p.options as never) as EscalationLevel;
  };

  it('reports the login, not renewable, and the run answering completes it', async () => {
    process.env.FAKE_CLAUDE_MODE = 'device-code';
    const r = recorder();
    expect(await level().answer(req(r.logins), new AbortController().signal)).toMatchObject({ answer: 'use postgres', escalate: false });
    expect(r.reports).toEqual([{ report: { kind: 'device_code', tool: 'gh', verificationUrl: 'https://github.com/login/device', userCode: 'WDJB-MJHT', expiresAt: expect.any(String) }, renewable: false }]);
    expect(r.ends).toEqual(['l1 completed']);
  });

  it('a run that fails after it fails the login, and its error carries no code', async () => {
    process.env.FAKE_CLAUDE_MODE = 'device-code-fails';
    const r = recorder();
    const reply = await level().answer(req(r.logins), new AbortController().signal);
    expect(reply).toMatchObject({ error: expect.stringContaining('claude exited 1') });
    expect(JSON.stringify(reply)).not.toContain('WDJB-MJHT');
    expect(r.ends).toEqual([expect.stringMatching(/^l1 failed: the run ended: claude exited 1/)]);
    expect(r.ends[0]).not.toContain('WDJB-MJHT');
  });
});

describe('a print-mode executor run (codex) that waits on a login', () => {
  const ex = createPrintAgentExecutor({ agent: 'codex', name: 'codex', bin: join(import.meta.dirname, '../adapters/fake-print-agent.mjs'), args: [], sshAuth: () => { throw new Error('no ssh'); } });
  beforeEach(() => { process.env.FAKE_AGENT_KIND = 'codex'; process.env.FAKE_AGENT_REPLY = 'Done.\nHOPPER_DONE'; });
  const ctxWith = (logins: RunLogins): ExecutionContext => {
    const job: Job = { id: 'job-login-1', spec: { executor: 'codex', payload: { prompt: 'go', cwd: join(dir, 'work'), makeWorkTree: true }, machineId: HERE.id }, priority: 50, status: 'running', approved: false, createdAt: '', updatedAt: '', attempts: 1 };
    return { job, laneId: 'local/lane-1', machine: HERE, signal: new AbortController().signal, progress() {}, saveState() {}, workTree() {}, logins };
  };

  it('reports the login while the turn runs; the turn finishing completes it', async () => {
    process.env.FAKE_AGENT_MODE = 'device-code';
    const r = recorder();
    expect(await ex.run(ctxWith(r.logins))).toMatchObject({ kind: 'finished' });
    expect(r.reports.map((x) => [x.report.tool, x.report.userCode, x.renewable])).toEqual([['codex', 'ABCD-EFGHJ', false]]);
    expect(r.ends).toEqual(['l1 completed']);
  });

  it('a turn that fails fails the login, and the job\'s error carries no code', async () => {
    process.env.FAKE_AGENT_MODE = 'device-code-fails';
    const r = recorder();
    const out = await ex.run(ctxWith(r.logins));
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringContaining('[code hidden]') });
    expect(JSON.stringify(out)).not.toContain('ABCD-EFGHJ');
    expect(r.ends).toEqual(['l1 failed: the run ended: exited 1']);
  });
});
