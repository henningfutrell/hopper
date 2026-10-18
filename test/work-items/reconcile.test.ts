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
//   Scenario: two hosts
//     Given hosts A and B on one database, each with its reconciler and sweep leases
//     Then only A acts while it holds the lease, and B acts once A stopped
import { afterEach, describe, expect, it } from 'vitest';
import { blockedStuck } from '../../src/domain/item-lifecycle.ts';
import { soleLease } from '../../src/domain/leases.ts';
import type { UserStore } from '../../src/domain/ports.ts';
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

  it('a job that ended done naming no pull request leaves its item blocked for want of one, and Failures lists it later', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const job = store.jobs.create(spec, 50, ref);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: T0 });
    const item = store.workItems.get(KEY)!;
    expect(item).toMatchObject({ state: 'blocked', blockedCause: 'no_pr' });
    expect(store.workItems.counts()).toMatchObject({ pr_open: 0, blocked: 1 });
    expect(blockedStuck(item, at(5))).toBe(false);
    expect(blockedStuck(item, at(10))).toBe(true);
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
    expect(reconciler(store, () => at(120)).reconcileOnce()).toBe(0);
    expect(reconciled(store)).toHaveLength(1);
  });

  it('of two hosts on one database, only the lease holder acts; the other takes over once it stopped', async () => {
    const url = installFromBefore(testDatabaseUrl());
    const hosts = ['a', 'b'].map((name) => {
      const instance = openInstanceStore({ url, clock: fixedClock(T0) });
      const store = instance.userStore(instance.users.get(ADMIN_ID)!);
      const leases = createHostLeases({ repo: instance.sweepLeases, owner: `test/${name}`, clock: { now: () => new Date() }, logger: quiet });
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
