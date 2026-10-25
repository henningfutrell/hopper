// The item reconciler's label rows (issue #1891, design.md "The item lifecycle", part 8): over the real database, a block
// the reconciler makes writes its issue's label change as GitHub outbox rows in the same transaction as the move, so the
// labels follow the database without a wait for the next discover; a second pass writes no more rows, and a move whose
// rows cannot be kept is not kept either.
//
// Feature: the label change of a block, with the block
//   Scenario: PR open past its deadline
//     Given an item in PR open whose job no longer follows its pull request
//     When the reconciler blocks it as stale
//     Then the outbox holds one row that takes hopper:pr-ready and hopper:partly-done off, and one that puts hopper:blocked on
//     And a second pass adds no row
//   Scenario: the rows cannot be kept
//     When the outbox write fails
//     Then the item is not blocked, and the next pass blocks it with its rows
//   Scenario: a job of a connected account's source
//     Given the same item, whose job's source is of kind github-account, as every job of a connected GitHub account's is
//     When the reconciler blocks it as stale
//     Then the outbox holds the same two rows, for that source
//   Scenario: no job of the item
//     Given an approved request card whose job was never queued
//     When the reconciler blocks it as stale
//     Then it writes no row: no job names the source, and the label mirror corrects it at the next discover
import { afterEach, describe, expect, it } from 'vitest';
import { coalesce } from '../../src/domain/github-outbox.ts';
import { soleLease } from '../../src/domain/leases.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { createItemReconciler } from '../../src/work-items/reconcile.ts';
import { spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/465';
const PR = 'https://github.com/o/r/pull/470';
const ref: JobSourceRef = { source: 'github', kind: 'github', key: KEY, repo: 'o/r', number: 465 };
const T0 = '2026-10-02T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const reconciler = (store: UserStore, now: string, outbox: UserStore['githubOutbox'] = store.githubOutbox) =>
  createItemReconciler({ ledger: store.workItems, jobs: store.jobs, events: store.events, outbox, lease: soleLease(), now: () => now, log: () => {} });

/** An item in PR open since T0 whose job no longer follows its pull request. */
function prOpenNotFollowed(store: UserStore): void {
  const job = store.jobs.create(spec, 50, ref);
  store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
  store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: T0 });
  store.events.append({ type: 'job.pull_request_followed', jobId: job.id, data: { pullRequest: PR, part: false }, at: T0 });
  store.jobs.update(job.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'tended' } } });
}

describe('the item reconciler writes the label change of a block through the outbox', () => {
  it('keeps the rows with the block, coalesced into one remove and one add, once', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    prOpenNotFollowed(store);
    expect(store.workItems.get(KEY)?.state).toBe('pr_open');

    expect(reconciler(store, at(61)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    const rows = store.githubOutbox.open('github');
    expect(rows.map((r) => ({ act: r.act, tag: r.tag, key: r.key, repo: r.repo, change: r.change }))).toEqual([
      { act: 'mirror', tag: 'blocked:stale', key: KEY, repo: 'o/r', change: { op: 'remove_labels', labels: ['hopper:pr-ready', 'hopper:partly-done', 'hopper:needs-merge'] } },
      { act: 'mirror', tag: 'blocked:stale', key: KEY, repo: 'o/r', change: { op: 'add_labels', labels: ['hopper:blocked'] } },
    ]);
    expect(coalesce(rows).map((p) => p.calls.map((c) => c.change))).toEqual([[
      { op: 'remove_labels', labels: ['hopper:pr-ready', 'hopper:partly-done', 'hopper:needs-merge'] },
      { op: 'add_labels', labels: ['hopper:blocked'] },
    ]]);

    // Idempotent: the next passes (the notice, then nothing) write no more rows.
    reconciler(store, at(120)).reconcileOnce();
    reconciler(store, at(180)).reconcileOnce();
    expect(store.githubOutbox.open('github')).toHaveLength(2);
  });

  it('keeps no block when its rows cannot be kept, and blocks the item with them at the next pass', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    prOpenNotFollowed(store);
    const failing: UserStore['githubOutbox'] = { ...store.githubOutbox, add: () => { throw new Error('the outbox write failed'); } };

    expect(reconciler(store, at(61), failing).reconcileOnce()).toBe(0);
    expect(store.workItems.get(KEY)?.state).toBe('pr_open');
    expect(store.events.recent(10, ['work_item.reconciled'])).toHaveLength(0);

    expect(reconciler(store, at(62)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    expect(store.githubOutbox.open('github')).toHaveLength(2);
  });

  it('keeps the rows of a block whose job came from a connected account\'s source (kind github-account, issue #1954)', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    const account: JobSourceRef = { ...ref, source: 'github-account', kind: 'github-account' };
    const job = store.jobs.create(spec, 50, account);
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 }, at: T0 });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' }, at: T0 });
    store.events.append({ type: 'job.pull_request_followed', jobId: job.id, data: { pullRequest: PR, part: false }, at: T0 });
    store.jobs.update(job.id, { status: 'finished', finishedAt: T0, sourceState: { source: { pullRequest: PR, follow: 'tended' } } });

    expect(reconciler(store, at(61)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    expect(store.githubOutbox.open('github-account').map((r) => r.change.op)).toEqual(['remove_labels', 'add_labels']);
  });

  it('writes no row for an item no job of which names its source', () => {
    const store = t.open(t.url());
    cleanups.push(() => store.close());
    store.events.append({ type: 'source.request_opened', data: { source: 'github', key: KEY }, at: T0 });
    store.events.append({ type: 'source.request_approved', data: { source: 'github', key: KEY }, at: T0 });

    expect(reconciler(store, at(61)).reconcileOnce()).toBe(1);
    expect(store.workItems.get(KEY)).toMatchObject({ state: 'blocked', blockedCause: 'stale' });
    expect(store.githubOutbox.open('github')).toEqual([]);
  });
});
