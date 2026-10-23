// A failure a job reported as a hopper bug (issue #1147, design.md "A failure the job reported as a hopper bug"): a job
// that filed a bug report on the hopper about itself while it ran, and then failed with a failure the rules hand to a
// person, is not handed to a person. It waits on its report: grouped into a problem of that report, held, with no
// hand-off. The problem holds only its own jobs. Once the report's issue is closed as completed — its fix landed — and
// this hopper's build is newer than that close, the problem resolves by its check and its jobs run again.
//
// Feature: a failure a job reported as a hopper bug
//   Scenario: a job reports a hopper bug, then fails
//     Then it is held on a problem of its report, not handed to a person, and other jobs still start
//   Scenario: the report is closed as completed
//     Then the problem resolves by its check, and the job's item runs again
//   Scenario: the report is closed as not planned
//     Then the problem stays open for a person
import { afterEach, describe, expect, it } from 'vitest';
import type { BugReport } from '../../src/domain/bug-reports.ts';
import type { FailuresView, Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot() {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(4) } });
  apps.push(a);
  return a;
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const chain = async (a: TestApp, key: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === key).reverse();

/**
 * A job that reports a hopper bug about itself (issue #1147 as `number`) before it fails as `message`. The report is
 * added as the job is queued, before it runs: under load the pull can return after its 1500 ms run failed (issue #2504).
 */
async function reportsThenFails(a: TestApp, message: string, number = 1147) {
  const key = `manual:report:${number}:${Date.now()}`;
  const store = a.user().store;
  let report: BugReport | undefined;
  const unsubscribe = store.events.subscribe((e) => {
    if (report || e.type !== 'job.queued' || !e.jobId || (e.data as { source?: { key?: string } }).source?.key !== key) return;
    report = store.bugReports.add({
      createdAt: new Date().toISOString(), by: `job ${e.jobId}`, jobId: e.jobId, fromJob: true, title: 'The shrink guard compares a push with the default branch',
      state: 'open', kind: 'issue', number, url: `https://github.com/henningfutrell/hopper/issues/${number}`, tries: 1,
    });
  });
  const job = await a.pull({ op: 'fail', message, ms: 1500 }, { key }).finally(unsubscribe);
  expect(report?.jobId).toBe(job.id);
  await a.waitForStatus(job.id, 'failed');
  const problem = await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.jobIds.includes(job.id)), { what: 'its problem' });
  return { job, report: report!, problem };
}

const NOT_COMPLETE = 'not complete: tending failed: the shrink guard refused its last push, which emptied or shrank src/update/update-commands.ts, and no push went through after';

describe('a failure a job reported as a hopper bug (issue #1147)', () => {
  it('is held on a problem of its report, not handed to a person; other jobs still start', async () => {
    const a = await boot();
    const { job, problem } = await reportsThenFails(a, NOT_COMPLETE);
    expect(problem).toMatchObject({ title: 'Hopper bug #1147', causeId: 'hopper-bug', status: 'open', decision: 'hold' });
    const view = await failuresOf(a);
    expect(view.recent.find((r) => r.jobId === job.id)).toMatchObject({ decision: 'hold', outcome: 'held', problemId: problem.id });
    expect(view.handoffs.filter((h) => h.jobId === job.id)).toEqual([]);
    expect(view.counts.needsPerson).toBe(0);
    const assessed = await waitFor(async () => (await a.job(job.id)).assessment);
    expect(assessed.reasons.join(' ')).toContain('it reported a hopper bug (#1147)');

    const other = await a.pull({ op: 'echo' });
    await a.waitForStatus(other.id, 'finished');
  });

  it('runs again once its report is closed as completed', async () => {
    const a = await boot();
    const { job, report, problem } = await reportsThenFails(a, 'HOPPER_FAILED the push was refused by the hopper');
    await a.user().failures.sweep();
    expect(await chain(a, job.source!.key)).toHaveLength(1);

    a.user().store.bugReports.update(report.id, { state: 'closed', closedAs: 'completed', closedAt: new Date(Date.now() - 60_000).toISOString() });
    await a.user().failures.sweep();
    const resolved = await waitFor(async () => (await a.events('types=failure.resolved')).find((e) => e.data.problemId === problem.id), { what: 'the problem resolved' });
    expect(resolved.data).toMatchObject({ by: 'check', released: 1 });
    await waitFor(async () => (await chain(a, job.source!.key)).length === 2 || undefined, { what: 'its item run again' });
  });

  it('stays open for a person when its report is closed as not planned', async () => {
    const a = await boot();
    const { report, problem } = await reportsThenFails(a, 'HOPPER_FAILED the push was refused by the hopper');
    a.user().store.bugReports.update(report.id, { state: 'closed', closedAs: 'not_planned', closedAt: new Date(Date.now() - 60_000).toISOString() });
    await a.user().failures.sweep();
    expect((await failuresOf(a)).problems.find((p) => p.id === problem.id)).toMatchObject({ status: 'open' });
  });
});
