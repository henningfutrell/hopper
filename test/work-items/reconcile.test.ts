// The item reconciler (issue #1891, design.md "The item lifecycle"): over the real database, an item the ledger has queued
// though its job finished is folded again from that end; an item in PR open past its deadline with no open pull request a
// job follows is blocked; a second pass adds nothing; and of two hosts on one database only the lease holder acts.
//
// Feature: the item reconciler
//   Scenario: queued after its job finished
//     Given a job that finished with its pull request, then an event that moved its item back to queued
//     When the reconciler runs two minutes later
//     Then one work_item.reconciled folds the item again: in PR open on that pull request
//     And a second pass adds no event
//   Scenario: a job's end with no pull request
//     Then its item is blocked for want of one at once, never in PR open, and Failures lists it ten minutes on
//     When its report names a pull request, the next pass puts it in PR open on it
//   Scenario: PR open past its deadline
//     Given an item in PR open whose job no longer follows its pull request
//     When the reconciler runs an hour on
//     Then the item is blocked as stale
//   Scenario: a state a job holds, past its deadline with no live job
//     Given an approved request card whose job was never queued, or an item partly done with no next part
//     When the reconciler runs past the state's deadline
//     Then the item is blocked as stale, a person is asked once, and a new job of the item takes it over
//   Scenario: a pull request closed without a merge
//     Given a job whose pull request was closed on GitHub without a merge
//     When the reconciler runs
//     Then it runs the item again once, with a brief that names the closed pull request, and its new job queues the item
//     And when the new job's pull request is closed too, the item stays blocked for a person, and nothing runs again
//   Scenario: one notice when an item is blocked
//     Given an item blocked as stale, or blocked after a second close
//     When the reconciler runs after it is stuck work
//     Then one work_item.person_asked asks a person, and the next pass asks nothing more
//   Scenario: two hosts
//     Given hosts A and B on one database, each with its reconciler and sweep leases
//     Then only A acts while it holds the lease, and B acts once A stopped
import { afterEach, describe, expect, it } from 'vitest';
import { blockedStuck } from '../../src/domain/item-lifecycle.ts';
import { soleLease } from '../../src/domain/leases.ts';
import type { RerunResult, UserStore } from '../../src/domain/ports.ts';
import { ADMIN_ID, type JobSourceRef } from '../../src/domain/types.ts';
import { createHostLeases, LEASE_ASK_MS } from '../../src/sagas/index.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { createItemReconciler } from '../../src/work-items/reconcile.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { fixedClock, spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/465';
const PR = 'https://github.com/o/r/pull/470';
const ref: JobSourceRef = { source: 'github', kind: 'github', key: KEY, repo: 'o/r', number: 465 };
const T0 = '2026-10-02T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const quiet = { info: () => {}, warn: () => {} };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const reconciler = (store: UserStore, now: () => string, lease = soleLease()) =>
  createItemReconciler({ ledger: store.workItems, jobs: store.jobs, events: store.events, lease, now, log: () => {} });
const reconciled = (store: UserStore) => store.events.recent(50, ['work_item.reconciled']);

/** A job of the item that finished at T0 with its pull request kept, then moved back to queued. */
function queuedAfterFinish(store: UserStore): string {
  const job = store.jobs.create(spec, 50, ref);
  store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
  store.events.append({ type: 'job.started', jobId: job.id, data: {}, at: T0 });
  store.jobs.update(job.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'open' } } });
  store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: T0 });
  store.events.append({ type: 'job.requeued', jobId: job.id, data: {}, at: T0 });
  return job.id;
}

describe('the item reconciler', () => {
  it('folds an item queued after its job finished again from that end, once', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    queuedAfterFinish(store);
    expect(store.workItems.get(KEY)?.state).toBe('queued');

    // Too new: the events in flight settle first.
    expect(reconciler(store, () => at(1)).reconcileOnce()).toBe(0);
    expect(reconciler(store, () => at(10)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'pr_open', pullRequest: PR, pullRequestState: 'open' });
    expect(reconciled(store)).toHaveLength(1);
    expect(reconciled(store)[0]!.data).toMatchObject({ key: KEY, from: 'queued', replay: { type: 'job.finished' } });

    // Idempotent: the next pass finds nothing to correct and adds no event.
    expect(reconciler(store, () => at(20)).reconcileOnce()).toBe(0);
    expect(reconciled(store)).toHaveLength(1);
    // A rebuild replays the correction to the same row.
    const live = store.workItems.get(KEY);
    store.workItems.rebuild();
    expect(store.workItems.get(KEY)).toEqual(live);
  });

  it('a job that ended done naming no pull request leaves its item blocked for want of one, and it runs again by itself (issue #2693)', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const job = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: T0 });
    const item = store.workItems.get(KEY)!;
    expect(item).toMatchObject({ state: 'blocked', blockedCause: 'no_pr' });
    expect(store.workItems.counts()).toMatchObject({ pr_open: 0, blocked: 1 });
    expect(blockedStuck(item, at(5))).toBe(false);
    expect(blockedStuck(item, at(10))).toBe(false);
    // Its report names a pull request: the next pass folds the item again from the job's end, in PR open on it.
    store.jobs.update(job.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'open' } } });
    expect(reconciler(store, () => at(5)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'pr_open', pullRequest: PR });
    expect(store.workItems.get(KEY)?.blockedCause).toBeUndefined();
  });

  it('blocks an item in PR open past its deadline whose pull request no job follows', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const job = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: T0 });
    store.events.append({ type: 'job.pull_request_followed', jobId: job.id, data: { pullRequest: PR, part: false }, at: T0 });
    store.jobs.update(job.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'tended' } } });
    expect(store.workItems.get(KEY)?.state).toBe('pr_open');

    expect(reconciler(store, () => at(30)).reconcileOnce()).toBe(0);
    expect(reconciler(store, () => at(61)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale', pullRequest: PR });
    // One notice: the next pass asks a person once, and a pass after it asks nothing more.
    expect(reconciler(store, () => at(120)).reconcileOnce()).toBe(1);
    expect(reconciler(store, () => at(180)).reconcileOnce()).toBe(0);
    expect(reconciled(store)).toHaveLength(1);
    expect(store.events.recent(10, ['work_item.person_asked']).map((e) => e.data)).toEqual([{ key: KEY, cause: 'stale', jobId: job.id, pullRequest: PR }]);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale', personAsked: true });
  });

  it('blocks an item queued with no live job past its deadline as stale, asks once, and a new job takes it over', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    store.events.append({ type: 'source.request_opened', data: { source: 'github', key: KEY }, at: T0 });
    store.events.append({ type: 'source.request_approved', data: { source: 'github', key: KEY }, at: T0 });
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'queued' });
    expect(store.workItems.get(KEY)?.jobId).toBeUndefined();

    expect(reconciler(store, () => at(30)).reconcileOnce()).toBe(0);
    expect(reconciler(store, () => at(61)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    expect(reconciled(store).map((e) => e.data)).toEqual([{ key: KEY, from: 'queued', cause: 'stale' }]);
    // One notice, then nothing more.
    expect(reconciler(store, () => at(70)).reconcileOnce()).toBe(1);
    expect(reconciler(store, () => at(80)).reconcileOnce()).toBe(0);
    expect(store.events.recent(10, ['work_item.person_asked']).map((e) => e.data)).toEqual([{ key: KEY, cause: 'stale' }]);
    // A new job of the item takes it over.
    const job = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: at(90) });
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'queued', jobId: job.id });
    expect(store.workItems.get(KEY)?.blockedCause).toBeUndefined();
  });

  it('never blocks an item queued whose job lives, however long it waits', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const job = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
    expect(reconciler(store, () => at(24 * 60)).reconcileOnce()).toBe(0);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'queued', jobId: job.id });
  });

  it('blocks an item partly done a day on with no next part as stale', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const job = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
    store.jobs.update(job.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'merged' } } });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'part done', partlyDone: PR }, at: T0 });
    store.events.append({ type: 'job.pull_request_merged', jobId: job.id, data: { pullRequest: PR, part: true }, at: T0 });
    expect(store.workItems.get(KEY)?.state).toBe('partly_done');

    expect(reconciler(store, () => at(23 * 60)).reconcileOnce()).toBe(0);
    expect(reconciler(store, () => at(24 * 60)).reconcileOnce()).toBe(1);
    // Its merged part is history: the item is not read as done by that merge.
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    expect(store.workItems.get(KEY)?.pullRequest).toBeUndefined();
    store.workItems.rebuild();
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
  });

  it('runs an item whose pull request was closed without a merge again once; a second close waits on a person', async () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const first = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: first.id, data: { spec, priority: 50 }, at: T0 });
    store.jobs.update(first.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'closed' } } });
    store.events.append({ type: 'job.finished', jobId: first.id, data: { result: 'pull request ready for review' }, at: T0 });
    store.events.append({ type: 'job.pull_request_closed', jobId: first.id, data: { pullRequest: PR, part: false }, at: T0 });
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 1 });
    expect(blockedStuck(store.workItems.get(KEY)!, at(10))).toBe(false);

    const asked: { jobId: string; brief: string }[] = [];
    let release: () => void = () => {};
    const runAgain = (jobId: string, brief: string) => {
      asked.push({ jobId, brief });
      return new Promise<RerunResult>((done) => {
        release = () => {
          const next = store.jobs.create(spec, 50, ref);
          store.events.append({ type: 'job.queued', jobId: next.id, data: { spec, priority: 50 }, at: at(10) });
          done({ ok: true, job: next });
        };
      });
    };
    const r = (now: string) => createItemReconciler({ ledger: store.workItems, jobs: store.jobs, events: store.events, lease: soleLease(), runAgain, now: () => now, log: () => {} });
    const one = r(at(10));
    expect(one.reconcileOnce()).toBe(1);
    expect(asked).toEqual([{ jobId: first.id, brief: expect.stringContaining(PR) as string }]);
    // A pass while its run again is under way starts no second; no event is added.
    store.workItems.checked(KEY, store.workItems.get(KEY)!.version, at(10));
    expect(one.reconcileOnce()).toBe(0);
    expect(asked).toHaveLength(1);
    release();
    await new Promise((done) => setTimeout(done, 0));
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'queued', closedWithoutMerge: 1 });
    expect(reconciled(store)).toHaveLength(0);

    // Its new job's pull request is closed without a merge too: blocked for a person, and listed in Failures.
    const second = store.jobs.getBySourceKey(KEY)!;
    store.jobs.update(second.id, { status: 'finished', finishedAt: at(20), sourceState: { source: { pullRequest: `${PR}1`, follow: 'closed' } } });
    store.events.append({ type: 'job.finished', jobId: second.id, data: { result: 'pull request ready for review' }, at: at(20) });
    store.events.append({ type: 'job.pull_request_closed', jobId: second.id, data: { pullRequest: `${PR}1`, part: false }, at: at(20) });
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'pr_closed', closedWithoutMerge: 2 });
    expect(blockedStuck(store.workItems.get(KEY)!, at(40))).toBe(true);
    // Nothing runs again: a person is asked once, as the item is stuck work.
    expect(r(at(40)).reconcileOnce()).toBe(1);
    expect(r(at(50)).reconcileOnce()).toBe(0);
    expect(asked).toHaveLength(1);
    expect(store.events.recent(10, ['work_item.person_asked']).map((e) => ({ jobId: e.jobId, data: e.data }))).toEqual([
      { jobId: second.id, data: { key: KEY, cause: 'pr_closed', jobId: second.id, pullRequest: `${PR}1` } },
    ]);
  });

  it('of two hosts on one database, only the lease holder acts; the other takes over once it stopped', async () => {
    const url = installFromBefore(testDatabaseUrl());
    const hosts = ['a', 'b'].map((name) => {
      const instance = openInstanceStore({ url, clock: fixedClock(T0) });
      const store = instance.userStore(instance.users.get(ADMIN_ID)!);
      const leases = createHostLeases({ repo: instance.sweepLeases, owner: `test/${name}`, logger: quiet });
      cleanups.push(() => { leases.stop(); store.close(); instance.close(); });
      return { store, leases, r: reconciler(store, () => at(10), leases.lease('item-reconcile')) };
    });
    const [a, b] = [hosts[0]!, hosts[1]!];
    queuedAfterFinish(a.store);

    expect(a.r.reconcileOnce()).toBe(1);
    expect(b.r.reconcileOnce()).toBe(0);
    a.leases.stop();
    await new Promise((r) => setTimeout(r, LEASE_ASK_MS + 50));
    // B holds the lease now; the item is corrected already, so it adds nothing more.
    expect(b.r.reconcileOnce()).toBe(0);
    expect(reconciled(b.store)).toHaveLength(1);
    // A second item drifts: B corrects it.
    const second = b.store.jobs.create(spec, 50, { ...ref, key: `${KEY}0`, number: 4650 });
    b.store.events.append({ type: 'job.queued', jobId: second.id, data: { spec, priority: 50 }, at: T0 });
    b.store.jobs.update(second.id, { status: 'failed', finishedAt: T0, error: 'boom' });
    b.store.events.append({ type: 'job.failed', jobId: second.id, data: { error: 'boom' }, at: T0 });
    b.store.events.append({ type: 'job.requeued', jobId: second.id, data: {}, at: T0 });
    expect(b.r.reconcileOnce()).toBe(1);
    expect(b.store.workItems.get(`${KEY}0`)).toMatchObject({ state: 'failed', failedJobId: second.id });
    expect(reconciled(b.store)).toHaveLength(2);
  });
});
