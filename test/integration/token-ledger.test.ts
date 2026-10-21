// The token ledger (issue #2302, part 1): the hopper reads what each job's agent spent from its agent session's log —
// at each checkpoint, and once more as its run ends — and keeps the counts per session and model, never the log's text.
// GET /api/jobs/:id/tokens answers a job's totals; GET /api/usage/tokens the rollups, split by a second group for the
// Dashboard's tokens over time (part 2); both say a job's waste signals and tokens per merged pull request (part 4). Real
// daemon over the fake herdr, as
// checkpoint.test.ts.
import { homedir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, Job } from '../../src/domain/types.ts';
import type { TokenRollupRow, TokenTotals } from '../../src/domain/token-usage.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

const DONE = { output: ['● Painted the shed blue.', '  HOPPER_DONE'] };
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} };
const tree = (): string => `${homedir()}/shed`;
const SECRET_TEXT = 'the prompt text of the job';

const assistant = (id: string, model: string, usage: object): string =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T08:00:00.000Z', requestId: `r-${id}`, message: { id, model, content: [{ type: 'text', text: SECRET_TEXT }], usage } });
const capture = (lines: string[]): CheckpointCapture => ({
  taken: { branch: 'hopper/shed', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: [], patch: gzipSync(''), session: gzipSync(`${lines.join('\n')}\n`) },
});
const ONE = [JSON.stringify({ type: 'user', message: { content: SECRET_TEXT } }), assistant('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 })];
const TWO = [...ONE, assistant('m2', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 })];

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

interface JobTokens { jobId: string; total: TokenTotals; models: (TokenTotals & { model: string })[]; sessions: number }

describe('the token ledger', () => {
  it('keeps a running job\'s token use at each checkpoint, read again in place of the one before', async () => {
    // The fake machine reads its options at each checkpoint: the session grows between two.
    const machine: { checkpoint: CheckpointCapture } = { checkpoint: capture(ONE) };
    const herdr = createFakeHerdrClient(Object.assign(machine, { session: 'jh-test', turns: [WORKING], repositories: [tree()] }));
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    const { agentSession } = await a.job(job.id);

    await a.user().engine.checkpoints.take(job.id);
    expect(a.user().store.tokenLedger.list({ jobId: job.id })).toMatchObject([{ session: agentSession, model: 'claude-opus-5-5', machineId: 'local', laneId: 'local/lane-1', turns: 1, input: 10, output: 100, cacheRead: 1000, cacheWrite: 500 }]);

    machine.checkpoint = capture(TWO);
    await a.user().engine.checkpoints.take(job.id);
    expect(a.user().store.tokenLedger.list({ jobId: job.id })).toMatchObject([{ turns: 2, input: 15, output: 150, cacheRead: 3000, cacheWrite: 500 }]);
  });

  it('reads it once more as the run ends, and answers a job\'s totals and the rollups with counts only', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], repositories: [tree()], checkpoint: capture(TWO) });
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished');
    expect(herdr.checkpoints.map((k) => k.jobId)).toContain(job.id);

    const tokens = await a.api<JobTokens>('GET', `/api/jobs/${job.id}/tokens`);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ jobId: job.id, sessions: 1, total: { turns: 2, input: 15, output: 150, cacheRead: 3000, cacheWrite: 500, costKnown: true } });
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, a cache write 1.25 × input.
    expect(tokens.body.total.costUsd).toBeCloseTo((15 * 4 + 150 * 20 + 3000 * 0.2 + 500 * 5) / 1e6, 9);
    expect(JSON.stringify(tokens.body)).not.toContain(SECRET_TEXT);

    const byModel = await a.api<{ total: TokenTotals; groups: TokenRollupRow[] }>('GET', `/api/usage/tokens?by=model&job=${job.id}`);
    expect(byModel.status).toBe(200);
    expect(byModel.body.groups).toMatchObject([{ key: 'claude-opus-5-5', jobs: 1, turns: 2 }]);
    expect(byModel.body.total.costUsd).toBeCloseTo(tokens.body.total.costUsd, 9);
    const byMachine = await a.api<{ groups: TokenRollupRow[]; top: { jobId: string }[] }>('GET', '/api/usage/tokens?by=machine&since=2026-10-01');
    expect(byMachine.body.groups).toMatchObject([{ key: 'local', jobs: 1 }]);
    expect(byMachine.body.top.map((t) => t.jobId)).toEqual([job.id]);

    expect((await a.api('GET', '/api/jobs/nope/tokens')).status).toBe(404);
    expect((await a.api('GET', '/api/usage/tokens?by=colour')).status).toBe(400);
  });

  it('answers tokens over time split by account and by repository, the parts reconciling with the ledger (part 2)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], repositories: [tree()], checkpoint: capture(TWO) });
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished');
    // A second session of the job, on another day, read with another account.
    a.user().store.tokenLedger.put(job.id, 'other-session', { models: [{ model: 'claude-haiku-4-5', turns: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }], last: '2026-10-22T09:00:00.000Z' },
      { readAt: '2026-10-22T09:00:00.000Z', machineId: 'local', account: 'second@example.test' });

    type Split = { total: TokenTotals; groups: (TokenRollupRow & { parts: TokenRollupRow[] })[] };
    const ledger = await a.api<{ total: TokenTotals }>('GET', `/api/usage/tokens?job=${job.id}`);
    const byAccount = await a.api<Split>('GET', `/api/usage/tokens?by=day&split=account&job=${job.id}`);
    expect(byAccount.status).toBe(200);
    expect(byAccount.body.groups.map((d) => d.key).sort()).toEqual(['2026-10-21', '2026-10-22']);
    expect(byAccount.body.groups.find((d) => d.key === '2026-10-22')!.parts).toMatchObject([{ key: 'second@example.test', input: 7, output: 3 }]);
    for (const d of byAccount.body.groups) expect(d.parts.reduce((n, p) => n + p.input + p.output + p.cacheRead + p.cacheWrite, 0)).toBe(d.input + d.output + d.cacheRead + d.cacheWrite);
    expect(byAccount.body.groups.reduce((n, d) => n + d.costUsd, 0)).toBeCloseTo(ledger.body.total.costUsd, 9);
    expect(byAccount.body.total).toEqual(ledger.body.total);

    // The test job names no repository: its part is (none), and still sums to its day.
    const byRepo = await a.api<Split>('GET', `/api/usage/tokens?by=day&split=repo&job=${job.id}`);
    expect(byRepo.body.groups.flatMap((d) => d.parts.map((p) => p.key))).toEqual(['(none)', '(none)']);
    expect(JSON.stringify(byRepo.body)).not.toContain(SECRET_TEXT);
    expect((await a.api('GET', '/api/usage/tokens?by=day&split=colour')).status).toBe(400);
  });

  it('flags a job whose test runs fail again and again, and divides the spend by the pull requests merged (part 4)', async () => {
    // Five test runs that failed, each a message of its own; the tool results' text is never kept.
    const failing = Array.from({ length: 5 }, (_, i) => [
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T08:10:00.000Z', requestId: `r-t${i}`, message: { id: `t${i}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'npx vitest run test/shed.test.ts' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, is_error: true, content: SECRET_TEXT }] } }),
    ]).flat();
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], repositories: [tree()], checkpoint: capture([...TWO, ...failing]) });
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished');

    const tokens = await a.api<JobTokens & { waste: { kind: string; why: string }[] }>('GET', `/api/jobs/${job.id}/tokens`);
    expect(tokens.body.total).toMatchObject({ turns: 7, failedTests: 5 });
    expect(tokens.body.waste).toEqual([{ kind: 'failing_tests', why: '5 test runs failed.' }]);
    expect(JSON.stringify(tokens.body)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(tokens.body)).not.toContain('vitest');

    type Rollup = { total: TokenTotals; waste: { jobId: string; signals: { kind: string }[] }[]; perMerged: { pullRequests: number; tokens?: number; costUsd?: number } };
    const before = await a.api<Rollup>('GET', '/api/usage/tokens');
    expect(before.body.waste).toMatchObject([{ jobId: job.id, signals: [{ kind: 'failing_tests' }] }]);
    expect(before.body.perMerged).toEqual({ pullRequests: 0 });

    // Its pull request merged: the spend divided by one.
    a.user().store.events.append({ type: 'job.pull_request_merged', jobId: job.id, data: { pullRequest: 'https://github.com/o/shed/pull/1', part: false } });
    const after = await a.api<Rollup>('GET', '/api/usage/tokens');
    const t = after.body.total;
    expect(after.body.perMerged.pullRequests).toBe(1);
    expect(after.body.perMerged.tokens).toBe(t.input + t.output + t.cacheRead + t.cacheWrite);
    expect(after.body.perMerged.costUsd).toBeCloseTo(t.costUsd, 9);
    // Another repository's filter counts no merge of this job.
    expect((await a.api<Rollup>('GET', '/api/usage/tokens?repo=o/other')).body.perMerged).toEqual({ pullRequests: 0 });
  });

  it('flags no waste for a job that spent little', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], repositories: [tree()], checkpoint: capture(TWO) });
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished');
    expect((await a.api<{ waste: unknown[] }>('GET', `/api/jobs/${job.id}/tokens`)).body.waste).toEqual([]);
    expect((await a.api<{ waste: unknown[] }>('GET', '/api/usage/tokens')).body.waste).toEqual([]);
  });

  // Part 6: the session's subagent logs are counted with it; the checkpoint keeps none of them.
  it('counts the session\'s subagents with it, a message both hold once, and keeps no subagent log', async () => {
    const SUB = assistant('a1', 'claude-haiku-4-5', { input_tokens: 7, output_tokens: 70 }).replace(SECRET_TEXT, 'the subagent text');
    const k = capture(ONE);
    if ('taken' in k) k.taken.subagents = gzipSync(`${ONE[1]}\n${SUB}\n`);
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING], repositories: [tree()], checkpoint: k });
    const a = await boot(herdr);
    const job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    await a.user().engine.checkpoints.take(job.id);
    expect(a.user().store.tokenLedger.list({ jobId: job.id }).map((e) => [e.model, e.turns, e.input, e.output])).toEqual([['claude-haiku-4-5', 1, 7, 70], ['claude-opus-5-5', 1, 10, 100]]);
    const kept = a.user().store.checkpoints.get(job.id)!;
    expect(gunzipSync(kept.session!).toString('utf8')).not.toContain('the subagent text');
  });

  it('keeps none for a job whose machine reads no session', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE], repositories: [tree()] });
    const a = await boot(herdr);
    const job: Job = await a.pull({}, item);
    await a.waitForStatus(job.id, 'finished');
    const tokens = await a.api<JobTokens>('GET', `/api/jobs/${job.id}/tokens`);
    expect(tokens.body).toMatchObject({ jobId: job.id, sessions: 0, total: { turns: 0, costUsd: 0 } });
  });
});
