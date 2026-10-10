// A hand-off's card says what happened from the real state of the job's work (issue #621): the hopper asks the job's
// source for its item and the pull requests the job opened or pushed to, keeps the answer on the hand-off, and the card
// says it in one plain sentence with one recommended resolution. When the work shipped — a pull request of the job's
// merged, or its item closed as completed — the hopper closes the hand-off itself: the job ends finished and its source
// is told so. Real daemon, real database, the manual source.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, WorkPullRequest } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource, type ManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(): Promise<{ a: TestApp; source: ManualSource }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const source = createManualSource();
  const a = await startTestApp({ dbPath: db.dbPath, source, plugins: { machines: lanes(4) } });
  apps.push(a);
  return { a, source };
}

const FAIL = { op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 };
let n = 0;
/** An item key, so its work is set before its job fails: the hopper checks a new hand-off at once. */
const key = () => `manual:work:${++n}:${Date.now()}`;
const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const pr = (number: number, o: Partial<WorkPullRequest> = {}): WorkPullRequest =>
  ({ url: `https://example.invalid/pull/${number}`, number, by: 'opened', state: 'open', draft: false, conflicting: false, ...o });

describe('Given a failed job handed off to a person', () => {
  it('When its pull request is a draft, Then the card says so in one sentence and recommends Continue, with an event', async () => {
    const { a, source } = await boot();
    const k = key();
    source.setWork(k, { pullRequests: [pr(9, { draft: true })] });
    const job = await a.pull(FAIL, { key: k });
    const h = await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.jobId === job.id && x.work !== undefined), { what: 'the hand-off checked' });
    expect(h.status).toBe('open');
    expect(h.card).toEqual({ whatHappened: 'The job opened PR #9. #9 is a draft.', recommended: 'continue', why: 'The job can finish the PR.' });
    const checked = await waitFor(async () => (await a.events('types=handoff.checked&limit=100')).find((e) => e.jobId === job.id));
    expect(checked.data).toEqual({ handoffId: h.id, item: 'open', pullRequests: 1, shipped: false });
  });

  it('When a pull request it pushed to is merged, Then the hopper closes the hand-off itself: the job ends finished and its source is told', async () => {
    const { a, source } = await boot();
    const k = key();
    source.setWork(k, { pullRequests: [pr(616, { by: 'updated', state: 'merged' })] });
    const job = await a.pull(FAIL, { key: k });
    const view = await waitFor(async () => {
      const v = await failuresOf(a);
      return v.handoffs.find((x) => x.jobId === job.id)?.status === 'closed' ? v : undefined;
    }, { what: 'the hand-off closed by itself' });
    const h = view.handoffs.find((x) => x.jobId === job.id)!;
    expect(h).toMatchObject({ end: 'finished', work: { item: 'open', pullRequests: [{ number: 616, state: 'merged' }] } });
    expect(h.card.whatHappened).toBe('The job updated PR #616. #616 is merged. The issue is still open.');
    expect(view.counts.needsPerson).toBe(0);
    expect((await a.job(job.id))).toMatchObject({ status: 'finished', result: { summary: 'The job updated PR #616. #616 is merged. The issue is still open.', link: 'https://example.invalid/pull/616' } });
    // Its end is told as finished, in place of the failure.
    await waitFor(async () => (source.reports.filter((r) => r.job.id === job.id).at(-1)?.kind === 'finished' ? true : undefined), { what: 'its finish reported' });
  });

  it('When its item is closed as completed, Then the work shipped: the hand-off closes and the job ends finished', async () => {
    const { a, source } = await boot();
    const k = key();
    source.setWork(k, { item: 'done', pullRequests: [] });
    const job = await a.pull(FAIL, { key: k });
    await waitFor(async () => ((await a.job(job.id)).status === 'finished' ? true : undefined), { what: 'the job finished' });
    expect((await failuresOf(a)).handoffs.find((x) => x.jobId === job.id)).toMatchObject({ status: 'closed', end: 'finished' });
  });
});
