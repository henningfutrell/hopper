// The item reconciler over the real database (issue #2693): an item whose job ended with no pull request, and whose report
// named none since, runs again by itself with a brief that says so, `NO_PR_RUNS_AGAIN` times in a row; only then is a person
// asked, once. Its block writes no `hopper:blocked`.
//
// Feature: no pull request found is no resting state
//   Scenario: a job ends with no pull request
//     Given a job that finished naming no pull request
//     When the reconciler runs ten minutes on
//     Then it runs the item again, with a brief that says the earlier job ended with no pull request, and adds no event
//     And when each new job ends with none too, it runs it again until the row is too long, then asks a person once
import { afterEach, describe, expect, it } from 'vitest';
import { NO_PR_RUNS_AGAIN } from '../../src/domain/item-lifecycle.ts';
import { soleLease } from '../../src/domain/leases.ts';
import type { RerunResult, UserStore } from '../../src/domain/ports.ts';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { createItemReconciler, noPullRequestBrief } from '../../src/work-items/reconcile.ts';
import { spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/2693';
const ref: JobSourceRef = { source: 'github', kind: 'github', key: KEY, repo: 'o/r', number: 2693 };
const T0 = '2026-10-02T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

/** A job of the item that finished at `when` naming no pull request, its report out. */
function finishedWithNone(store: UserStore, when: string): string {
  const job = store.jobs.create(spec, 50, ref);
  store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: when });
  store.jobs.update(job.id, { status: 'finished', finishedAt: when, sourceState: { source: { follow: 'open' } } });
  store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: when });
  return job.id;
}

describe('the item reconciler, no pull request found (issue #2693)', () => {
  it('runs the item again by itself, a few times in a row, then asks a person once', async () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const asked: { jobId: string; brief: string }[] = [];
    let ends = 0;
    // Each run again makes the item's next job, which ends with no pull request too.
    const runAgain = (jobId: string, brief: string): Promise<RerunResult> => {
      asked.push({ jobId, brief });
      ends += 1;
      const next = finishedWithNone(store, at(20 * ends));
      return Promise.resolve({ ok: true, job: store.jobs.get(next)! });
    };
    const r = (minutes: number) => createItemReconciler({ ledger: store.workItems, jobs: store.jobs, events: store.events, outbox: store.githubOutbox, lease: soleLease(), runAgain, now: () => at(minutes), log: () => {} });
    const first = finishedWithNone(store, T0);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'no_pr', noPullRequestEnds: 1 });

    // Its report had a moment to name one: not yet.
    expect(r(5).reconcileOnce()).toBe(0);
    expect(r(10).reconcileOnce()).toBe(1);
    await new Promise((done) => setTimeout(done, 0));
    expect(asked).toEqual([{ jobId: first, brief: noPullRequestBrief() }]);
    expect(noPullRequestBrief()).toContain('ended with no pull request');
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', noPullRequestEnds: 2 });

    for (let pass = 2; pass <= NO_PR_RUNS_AGAIN; pass += 1) {
      expect(r(20 * (pass - 1) + 10).reconcileOnce()).toBe(1);
      await new Promise((done) => setTimeout(done, 0));
    }
    expect(asked).toHaveLength(NO_PR_RUNS_AGAIN);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'no_pr', noPullRequestEnds: NO_PR_RUNS_AGAIN + 1 });
    // The row is too long: nothing runs again, and a person is asked once.
    expect(r(200).reconcileOnce()).toBe(1);
    expect(r(300).reconcileOnce()).toBe(0);
    expect(asked).toHaveLength(NO_PR_RUNS_AGAIN);
    expect(store.events.recent(10, ['work_item.person_asked']).map((e) => e.data)).toEqual([{ key: KEY, cause: 'no_pr', jobId: store.workItems.get(KEY)!.jobId }]);
    // No block, and no label row: the item was never blocked by the reconciler for want of a pull request.
    expect(store.events.recent(10, ['work_item.reconciled'])).toEqual([]);
  });
});
