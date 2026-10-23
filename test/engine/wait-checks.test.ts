// Issue #1694: the wait checks, against the real database. Each hopper here is a store of its own on the same user schema and
// a sweeper of its own, with its own lease owner, as two hoppers (or a hopper after a restart) are.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry, UserStore } from '../../src/domain/ports.ts';
import type { Job, JobWait } from '../../src/domain/types.ts';
import type { WatchedEnd, WatchedRef } from '../../src/domain/watched-items.ts';
import { DEADLINE_MS, FIRST_CHECK_MS, MAX_EVERY_MS, type WaitedChecks, type WaitedReviews } from '../../src/domain/wait-checks.ts';
import { createWaitChecks, LEASE_MS, type WaitReads } from '../../src/engine/wait-checks.ts';
import { openDb } from '../../src/store/db.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { testDatabaseUrl } from '../support/database.ts';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
let now = T0;
const clock = { now: () => new Date(now) };
const opened: UserStore[] = [];
const noExecutors = { get: () => undefined, names: () => [] } as unknown as ExecutorRegistry;

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  now = T0;
});

/** `skewMs`: this hopper's clock is that far ahead of the test's time (behind, when negative), as a machine's clock that is off. */
function hopper(url: string, reads: WaitReads, owner = randomUUID(), skewMs = 0) {
  const own = skewMs ? { now: () => new Date(now + skewMs) } : clock;
  const store = openUserStore({ url, clock: own, idGen: randomUUID });
  opened.push(store);
  const triggers: string[] = [];
  const checks = createWaitChecks({ store, clock: own, executors: noExecutors, stopping: () => false, trigger: (r) => triggers.push(r), ownCommandGraceMs: 300_000, waitReads: reads }, { owner });
  return { store, checks, triggers };
}

/** Reads that answer what `ended` holds now, counted; `gate`: each read waits for it first. */
function reads(o: { ended?: WatchedEnd[]; gate?: Promise<void> } = {}) {
  const asked: WatchedRef[][] = [];
  const r = {
    asked, ended: o.ended ?? [],
    async endedWatched(_job: Job, refs: WatchedRef[]) { asked.push(refs); await o.gate; return r.ended; },
  };
  return r;
}

const ISSUE = { kind: 'issue' as const, repo: 'octo/tools', number: 9 };
const CLOSED: WatchedEnd = { ref: ISSUE, url: 'https://github.com/octo/tools/issues/9', state: 'closed' };

function waitingJob(store: UserStore, wait: Partial<JobWait> = {}): Job {
  const job = store.jobs.create({ executor: 'x', payload: {} }, 50, { source: 's', kind: 'github', key: 'https://github.com/octo/tools/issues/7', repo: 'octo/tools', number: 7 });
  return store.jobs.update(job.id, { status: 'waiting_on', wait: { for: 'issue 9 to close', since: new Date(now).toISOString(), on: { kind: 'item', number: 9 }, ...wait } });
}

/** Ends every wait-check lease of `url` at once. */
function endLeases(url: string): void {
  const db = openDb(url);
  try { db.run("UPDATE wait_check_leases SET until = '1970-01-01T00:00:00.000Z'"); } finally { db.close(); }
}

const ended = (s: UserStore, id: string) => s.events.recent(50, ['job.wait_ended'], id);

describe('a wait check (issue #1694)', () => {
  it('is kept with the wait: its condition and next check; a restarted hopper goes on from it and ends the wait once met', async () => {
    const url = testDatabaseUrl();
    const r1 = reads();
    const a = hopper(url, r1);
    const job = waitingJob(a.store);

    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({
      condition: { kind: 'items_ended', refs: [ISSUE] }, attempts: 0, nextCheckAt: new Date(T0 + FIRST_CHECK_MS).toISOString(),
    });
    expect(r1.asked).toEqual([]);

    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    const after = a.store.jobs.get(job.id)!;
    expect(after.status).toBe('waiting_on');
    expect(after.wait!.check).toMatchObject({ attempts: 1, result: 'not ended yet: octo/tools#9', nextCheckAt: new Date(now + FIRST_CHECK_MS).toISOString() });

    // The hopper stops; another starts on the same database.
    const r2 = reads({ ended: [CLOSED] });
    const b = hopper(url, r2);
    now += FIRST_CHECK_MS;
    await b.checks.run();

    const woken = b.store.jobs.get(job.id)!;
    expect(woken.status).toBe('queued');
    expect(woken.wait).toBeUndefined();
    expect(woken.pendingAnswer).toContain('https://github.com/octo/tools/issues/9 was closed');
    expect(ended(b.store, job.id).map((e) => e.data)).toEqual([{ by: 'hopper', note: 'https://github.com/octo/tools/issues/9 was closed', check: 'items_ended:issue:octo/tools#9' }]);
    expect(b.triggers).toContain('job.wait_ended');
  });

  it('two hoppers, and two passes at once: the wait is read and ended once', async () => {
    const url = testDatabaseUrl();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const ra = reads({ ended: [CLOSED], gate }), rb = reads({ ended: [CLOSED], gate });
    const a = hopper(url, ra), b = hopper(url, rb);
    const job = waitingJob(a.store);
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;

    const passes = [a.checks.run(), a.checks.run(), b.checks.run()];
    await new Promise((r) => setTimeout(r, 50));
    open();
    await Promise.all(passes);

    expect(ra.asked.length + rb.asked.length).toBe(1);
    expect(ended(a.store, job.id)).toHaveLength(1);
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');
  });

  it('a hopper that stops mid-check: another takes the wait once its lease ends, and the first one\'s late answer changes nothing', async () => {
    const url = testDatabaseUrl();
    let late!: () => void;
    const hung = reads({ ended: [CLOSED], gate: new Promise<void>((resolve) => { late = resolve; }) });
    const a = hopper(url, hung);
    const rb = reads({ ended: [CLOSED] });
    const b = hopper(url, rb);
    const job = waitingJob(a.store);
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;

    const stuck = a.checks.run();
    await new Promise((r) => setTimeout(r, 50));
    await b.checks.run();
    expect(rb.asked).toEqual([]);

    // Its lease ends, as its time would: on the database's clock (issue #1954).
    endLeases(url);
    await b.checks.run();
    expect(rb.asked).toHaveLength(1);
    expect(b.store.jobs.get(job.id)!.status).toBe('queued');

    late();
    await stuck;
    expect(ended(b.store, job.id)).toHaveLength(1);
  });

  for (const c of [{ what: 'the second hopper\'s clock is ahead', first: 0, second: 2 * LEASE_MS }, { what: 'the first hopper\'s clock is behind', first: -2 * LEASE_MS, second: 0 }]) {
    it(`two hoppers whose clocks do not agree (issue #1954): ${c.what}, and the second never tests the wait the first tests`, async () => {
      const url = testDatabaseUrl();
      let late!: () => void;
      const hung = reads({ ended: [CLOSED], gate: new Promise<void>((resolve) => { late = resolve; }) });
      const a = hopper(url, hung, randomUUID(), c.first);
      const rb = reads({ ended: [CLOSED] });
      const b = hopper(url, rb, randomUUID(), c.second);
      const job = waitingJob(a.store, { since: new Date(now + c.first).toISOString() });
      await a.checks.run();
      now = T0 + FIRST_CHECK_MS;

      const stuck = a.checks.run();
      await new Promise((r) => setTimeout(r, 50));
      expect(hung.asked).toHaveLength(1);
      await b.checks.run();
      expect(rb.asked, 'the second hopper tested the wait the first tests').toEqual([]);

      late();
      await stuck;
      expect(ended(a.store, job.id)).toHaveLength(1);
    });
  }

  it('a wait that names an item that does not exist ends at once, though its other items are open (issue #1691)', async () => {
    const url = testDatabaseUrl();
    const GONE = { kind: 'issue' as const, repo: 'octo/tools', number: 404 };
    const r = reads({ ended: [{ ref: GONE, url: 'https://github.com/octo/tools/issues/404', state: 'not_found' }] });
    const a = hopper(url, r);
    const job = waitingJob(a.store, { for: 'octo/tools#9 and octo/tools#404 to close', on: { kind: 'outside', what: 'x' } });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');
    expect(ended(a.store, job.id)[0]!.data).toMatchObject({ by: 'hopper', note: 'https://github.com/octo/tools/issues/404 cannot be read: no such repository or item, or the hopper has no access to it, so the wait never ends on it; check the owner and name you wrote' });
  });

  it('a wait on another job ends when that job ends, read from the store with no outside read', async () => {
    const url = testDatabaseUrl();
    const r = reads();
    const a = hopper(url, r);
    const other = a.store.jobs.create({ executor: 'x', payload: {} }, 50);
    const job = waitingJob(a.store, { for: 'the other job', on: { kind: 'job', jobId: other.id } });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ attempts: 1, result: `job ${other.id} is queued` });

    a.store.jobs.update(other.id, { status: 'finished' });
    now += 2 * FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');
    expect(ended(a.store, job.id)[0]!.data).toMatchObject({ by: 'hopper', note: `job ${other.id} finished` });
    expect(r.asked).toEqual([]);
  });

  it('a wait the hopper cannot test is overdue once past its deadline, and stays on its wait', async () => {
    const url = testDatabaseUrl();
    const a = hopper(url, reads());
    const job = waitingJob(a.store, { for: 'a person to grant access', on: { kind: 'grant' } });
    await a.checks.run();
    now = T0 + DEADLINE_MS;
    await a.checks.run();
    now += 2 * 3600_000;
    await a.checks.run();

    const overdue = a.store.events.recent(50, ['job.wait_overdue'], job.id);
    expect(overdue.map((e) => e.data)).toEqual([{ deadline: new Date(T0 + DEADLINE_MS).toISOString(), result: 'the hopper has no check for a vault grant' }]);
    const still = a.store.jobs.get(job.id)!;
    expect(still.status).toBe('waiting_on');
    expect(still.wait!.check!.overdueAt).toBe(new Date(T0 + DEADLINE_MS).toISOString());
  });

  it('a job woken for items that ended, that waits on them again, is not woken for them again: its wait is overdue at once', async () => {
    const url = testDatabaseUrl();
    const r = reads({ ended: [CLOSED] });
    const a = hopper(url, r);
    const job = waitingJob(a.store);
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');

    a.store.jobs.update(job.id, { status: 'waiting_on', wait: { for: 'issue 9 to close', since: new Date(now).toISOString(), on: { kind: 'item', number: 9 } } });
    await a.checks.run();
    now += FIRST_CHECK_MS;
    await a.checks.run();

    const again = a.store.jobs.get(job.id)!;
    expect(again.status).toBe('waiting_on');
    expect(again.wait!.check).toMatchObject({ overdueAt: new Date(now).toISOString() });
    expect(ended(a.store, job.id)).toHaveLength(1);
    expect(a.store.events.recent(50, ['job.wait_overdue'], job.id)).toHaveLength(1);
  });

  it('a recheck (issues #2335, #2338): an outside event with a check-in ends at it, and the job is told to look again', async () => {
    const url = testDatabaseUrl(), a = hopper(url, reads()), b = hopper(url, reads());
    const job = waitingJob(a.store, { for: 'the deploy to finish', on: { kind: 'outside', what: 'the deploy to finish' }, checkLine: 'in 30m' }), at = new Date(T0 + MAX_EVERY_MS).toISOString();
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ condition: { kind: 'recheck', at }, nextCheckAt: at });
    // Another hopper on the same database ends it at its time.
    now = T0 + MAX_EVERY_MS;
    await b.checks.run();
    expect(b.store.jobs.get(job.id)).toMatchObject({ status: 'queued', pendingAnswer: expect.stringContaining('cannot see what you wait on (the deploy to finish)') });
    expect(ended(b.store, job.id)[0]!.data).toMatchObject({ by: 'hopper', check: `recheck:${at}` });
  });

  it('a time the job named: a wait the hopper cannot test ends at it, and not before (part 2)', async () => {
    const url = testDatabaseUrl();
    const a = hopper(url, reads());
    const job = waitingJob(a.store, { for: 'the deploy window', on: { kind: 'outside', what: 'the deploy window' }, checkLine: 'after 2h' });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ condition: { kind: 'time_passed' }, attempts: 0 });

    // The hopper restarts: the check is kept, and another hopper ends the wait at the time.
    const b = hopper(url, reads());
    now = T0 + 2 * 3600_000;
    await b.checks.run();
    expect(b.store.jobs.get(job.id)!.status).toBe('queued');
    expect(ended(b.store, job.id)[0]!.data).toMatchObject({ by: 'hopper', note: `the time you named passed (${new Date(now).toISOString()})` });
  });

  it('a time the job named beside a condition: the wait ends at it, though the condition is not met', async () => {
    const url = testDatabaseUrl();
    const r = reads();
    const a = hopper(url, r);
    const job = waitingJob(a.store, { checkLine: 'after 3m' });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    now = T0 + 2 * 60_000;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ attempts: 2, nextCheckAt: new Date(T0 + 3 * 60_000).toISOString() });
    now = T0 + 3 * 60_000;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');
    expect(ended(a.store, job.id)[0]!.data).toMatchObject({ note: `the time you named passed (${new Date(now).toISOString()}); not ended yet: octo/tools#9` });
  });

  it('a wait on a pull request\'s checks: not met while they run, then ended when they pass (part 2)', async () => {
    const url = testDatabaseUrl();
    const r = reads();
    const states: WaitedChecks[] = [];
    const a = hopper(url, { ...r, async pullRequestChecks(_job, repo, number) { states.push({ url: `https://github.com/${repo}/pull/${number}`, state: 'open' }); return { ...states.at(-1)!, ...pr }; } });
    let pr: Partial<WaitedChecks> = { checks: 'pending' };
    const job = waitingJob(a.store, { for: 'the checks of PR 8', on: { kind: 'pull_request', number: 8, about: 'checks' } });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ result: 'the checks of https://github.com/octo/tools/pull/8 run', nextCheckAt: new Date(now + FIRST_CHECK_MS).toISOString() });

    pr = { checks: 'passing' };
    now += FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');
    expect(ended(a.store, job.id)[0]!.data).toMatchObject({ note: 'the checks of https://github.com/octo/tools/pull/8 passed', check: 'pr_checks_ended:octo/tools#8' });
    expect(r.asked).toEqual([]);
  });

  it('a pull request read that fails: the check says GitHub\'s error, and asks again later (issue #2210)', async () => {
    const url = testDatabaseUrl();
    let fail = true;
    const a = hopper(url, { ...reads(), async pullRequestChecks(_job, repo, number) {
      if (fail) throw new Error(`pull request ${repo}#${number}: Resource not accessible by integration`);
      return { url: `https://github.com/${repo}/pull/${number}`, state: 'open', checks: 'passing' };
    } });
    const job = waitingJob(a.store, { for: 'the checks of PR 8', on: { kind: 'pull_request', number: 8, about: 'checks' } });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({
      result: 'the hopper cannot read octo/tools#8 now: pull request octo/tools#8: Resource not accessible by integration', nextCheckAt: new Date(now + FIRST_CHECK_MS).toISOString(),
    });
    // Issue #2684: its wait broke, until a check reads it again.
    expect(a.store.jobs.get(job.id)!.wait!.check!.brokenAt).toBe(new Date(now).toISOString());

    fail = false;
    now += FIRST_CHECK_MS;
    await a.checks.run();
    expect(ended(a.store, job.id)[0]!.data).toMatchObject({ note: 'the checks of https://github.com/octo/tools/pull/8 passed' });
  });

  it('a job whose source reads no pull request: the check says so (issue #2210)', async () => {
    const url = testDatabaseUrl();
    const a = hopper(url, { ...reads(), async pullRequestChecks() { return undefined; }, async pullRequestReviews() { return undefined; } });
    const checks = waitingJob(a.store, { for: 'the checks of PR 8', on: { kind: 'pull_request', number: 8, about: 'checks' } });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(checks.id)!.wait!.check).toMatchObject({ result: 'the job\'s source reads no pull request, so the hopper cannot read octo/tools#8', brokenAt: new Date(now).toISOString() });
  });

  it('a wait on a pull request\'s review: not met with no review since it began, then ended by a new review (part 3)', async () => {
    const url = testDatabaseUrl();
    const r = reads();
    let pr: WaitedReviews = { url: 'https://github.com/octo/tools/pull/8', state: 'open', reviews: [{ state: 'changes_requested', submittedAt: new Date(T0 - 3600_000).toISOString() }] };
    const a = hopper(url, { ...r, async pullRequestReviews() { return pr; } });
    const job = waitingJob(a.store, { for: 'a review of PR 8', on: { kind: 'pull_request', number: 8, about: 'review' } });
    await a.checks.run();
    now = T0 + FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ result: 'no review of https://github.com/octo/tools/pull/8 since the wait began' });

    pr = { ...pr, reviews: [...pr.reviews!, { state: 'approved', submittedAt: new Date(now).toISOString() }] };
    now += FIRST_CHECK_MS;
    await a.checks.run();
    expect(a.store.jobs.get(job.id)!.status).toBe('queued');
    expect(ended(a.store, job.id)[0]!.data).toMatchObject({ note: 'https://github.com/octo/tools/pull/8 was approved', check: 'pr_review_ended:octo/tools#8' });
    expect(r.asked).toEqual([]);
  });
});
