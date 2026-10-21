// The token budget (issue #2302, part 3): an admin sets the most one job may spend, in tokens or estimated cost. A running
// job whose token ledger reaches it at a checkpoint is paused — parked, its agent session and work tree kept, not killed —
// and says why. A person's pick up lets it go on with a whole budget again, counted from what it had spent then. Real
// daemon over the fake herdr, as token-ledger.test.ts.
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, Job } from '../../src/domain/types.ts';
import type { TokenBudgetSettings } from '../../src/domain/token-budget.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} };
const tree = (): string => `${homedir()}/shed`;

const assistant = (id: string, usage: object): string =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T08:00:00.000Z', requestId: `r-${id}`, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage } });
const capture = (lines: string[]): CheckpointCapture => ({
  taken: { branch: 'hopper/shed', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: [], patch: gzipSync(''), session: gzipSync(`${lines.join('\n')}\n`) },
});
// 1,610 tokens, then 3,665 in all.
const ONE = [assistant('m1', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 })];
const TWO = [...ONE, assistant('m2', { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 })];

async function boot(herdr: FakeHerdrClient): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }] }, seams: { herdr } });
  apps.push(a);
  return a;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const setBudget = (a: TestApp, token: string, body: Partial<TokenBudgetSettings>) => a.ui<TokenBudgetSettings>('/ui/api/token-budget', body, { token });

describe('the token budget', () => {
  it('is off by default; an admin changes it, and the change is an event', async () => {
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }));
    const token = await a.login();
    expect((await a.api('GET', '/api/token-budget')).body).toEqual({ jobTokens: 0, jobCostUsd: 0 });
    const r = await setBudget(a, token, { jobCostUsd: 5 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ jobTokens: 0, jobCostUsd: 5 });
    expect((await a.api('GET', '/api/token-budget')).body).toEqual({ jobTokens: 0, jobCostUsd: 5 });
    expect((await a.events('types=token_budget.settings_changed'))[0]!.data).toMatchObject({ from: { jobTokens: 0, jobCostUsd: 0 }, to: { jobTokens: 0, jobCostUsd: 5 } });
    expect((await setBudget(a, token, { jobTokens: -1 })).status).toBe(400);
    expect((await setBudget(a, token, {})).status).toBe(400);
  });

  it('pauses a running job that reaches it; a pick up lets it go on, counted from what it had spent', async () => {
    const machine: { checkpoint: CheckpointCapture } = { checkpoint: capture(ONE) };
    const herdr = createFakeHerdrClient(Object.assign(machine, { session: 'jh-test', turns: [WORKING, WORKING], repositories: [tree()] }));
    const a = await boot(herdr);
    const token = await a.login();
    await setBudget(a, token, { jobTokens: 1000 });
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });

    await a.user().engine.checkpoints.take(job.id);
    const parked = await a.waitForStatus(job.id, 'parked', 5000);
    const why = 'Paused: the job used 1,610 tokens, its token budget is 1,000 tokens.';
    expect(parked.laneId).toBeUndefined();
    expect(parked.agentSession).toBeDefined();
    expect(parked.parked).toMatchObject({ from: 'running', auto: true, why });
    expect(parked.budgetPaused).toMatchObject({ tokens: 1610, why });
    expect((await a.events()).find((e) => e.jobId === job.id && e.type === 'job.parked')!.data).toMatchObject({ from: 'running', auto: true, why });

    // A person lets it go on: its budget counts again from the 1,610 tokens it had spent.
    const r = await a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.budgetPaused).toBeUndefined();
    expect(r.body.budgetFrom).toMatchObject({ tokens: 1610 });
    await a.waitForStatus(job.id, 'running', 5000);
    await a.user().engine.checkpoints.take(job.id);
    expect((await a.job(job.id)).status).toBe('running');

    // 2,055 more tokens: the budget is reached again.
    machine.checkpoint = capture(TWO);
    await a.user().engine.checkpoints.take(job.id);
    const again = await a.waitForStatus(job.id, 'parked', 5000);
    expect(again.parked?.why).toBe('Paused: the job used 2,055 tokens since it was let go on, its token budget is 1,000 tokens.');
  });

  it('leaves a job under its budget running', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: capture(ONE) });
    const a = await boot(herdr);
    const token = await a.login();
    await setBudget(a, token, { jobTokens: 2000 });
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    await a.user().engine.checkpoints.take(job.id);
    expect((await a.job(job.id)).status).toBe('running');
  });
});
