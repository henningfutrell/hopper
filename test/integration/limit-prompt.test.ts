// Issue #2897: an account's limit, end to end. Every hit folds into one problem whatever the prompt says; the job does not
// wait for its timeout; a new job is held saying every account is at its limit; at the reset time the problem resolves
// by itself and the jobs go on.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(4) } });
  apps.push(a);
  return a;
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const fail = (message: string, ms = 0) => ({ op: 'fail', message, ms });

describe('a limit prompt', () => {
  // Both at work when the first hits the limit: after it, the account takes no new job.
  const limit = (prompt: string) => fail(`usage or access limit (usage): the agent stopped at: ${prompt}`, 800);

  it('one problem for its account, the job held with the limit reason, and released at the reset time', async () => {
    const a = await boot();
    const resets = new Date(Date.now() + 8000).toISOString();
    const first = await a.pull(limit(`You've hit your limit · resets at ${resets}`));
    const second = await a.pull(limit(`Weekly limit reached · resets at ${resets}`));
    for (const j of [first, second]) await a.waitForStatus(j.id, 'failed');
    const problem = await waitFor(async () => {
      const open = (await failuresOf(a)).problems.filter((p) => p.status === 'open');
      return open.length === 1 && open[0]!.jobIds.length === 2 ? open[0] : undefined;
    }, { what: 'one open problem with both jobs' });
    expect(problem).toMatchObject({ title: expect.stringMatching(/^Usage or access limit on /), causeId: 'agent-limit', limit: { family: 'usage', resetsAt: resets, resetNamed: true } });
    expect(problem.limit!.laneId).toBeDefined();
    expect(problem.limit!.prompt).toMatch(/limit/);
    expect((await waitFor(async () => (await a.events('types=job.assessed&limit=1000')).find((e) => e.jobId === first.id))).data).toMatchObject({ causeId: 'agent-limit', class: 'shared', decision: 'redirect' });
    expect((await a.job(first.id)).error).toMatch(/^usage or access limit \(usage\)/);

    const queued = await a.pull({ op: 'echo', message: 'hi' });
    expect((await a.waitForStatus(queued.id, 'held')).holdReason).toBe(`held by problem: ${problem.title}: every account is at its usage limit`);
    const view = (await failuresOf(a)).problems[0]!;
    expect(view.limitDid).toHaveLength(2);

    await waitFor(async () => (await a.job(queued.id)).status === 'finished', { timeoutMs: 20_000, what: 'the held job run at the reset time' });
    const resolved = await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.id === problem.id));
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: 'check' });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(resets));
  }, 30_000);

  it('a prompt that names no time: the account is skipped for a while, and a person may resolve it', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull(fail('usage or access limit (access): the agent stopped at: Ask your admin to enable access'));
    await a.waitForStatus(job.id, 'failed');
    const problem = await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.status === 'open'));
    expect(problem.limit).toMatchObject({ family: 'access', resetNamed: false });
    expect(Date.parse(problem.limit!.resetsAt)).toBeGreaterThan(Date.now() + 3_000_000);
    expect((await a.ui(`/ui/api/failures/problems/${problem.id}/resolve`, {}, { token })).status).toBe(200);
  });

  it('with two machines the job runs again on the other, and is held once both are at their limit', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const machines = (['seat', 'host'] as const).map((name) => ({ name, plugin: 'local', options: { lanes: 1, session: `${name}-s` } }));
    const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines } });
    apps.push(a);
    const first = await a.pull(fail('usage or access limit (usage): the agent stopped at: Usage limit reached'));
    await a.waitForStatus(first.id, 'failed');
    const jobsOf = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.filter((j) => j.source?.key === first.source!.key).reverse();
    const [, second, third] = await waitFor(async () => { const c = await jobsOf(); return c.length === 3 && c[2]!.status === 'held' ? c : undefined; }, { timeoutMs: 15_000, what: 'a run on the other machine, then the hold' });
    expect(second!.laneId!.split('/')[0]).not.toBe((await a.job(first.id)).laneId!.split('/')[0]);
    expect(third!.holdReason).toMatch(/every account is at its usage limit$/);
    const { problems } = await failuresOf(a);
    expect(problems.filter((p) => p.status === 'open')).toHaveLength(2);
    expect(problems.flatMap((p) => p.limitDid ?? []).join('\n')).toMatch(/rerouted to|held,/);
  }, 30_000);
});
