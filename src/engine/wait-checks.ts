// The wait sweeper (issue #1694, design.md "Wait checks"): on each engine tick, every job on its own wait gets its wait check
// (domain/wait-checks.ts) kept with its wait, and each check due is taken under a lease and tested. A condition met ends the
// wait (`job.wait_ended { by: hopper }`): the job is queued again and told why. Not met: tried again later, the time between
// doubling; past its deadline, overdue once (`job.wait_overdue`), a stuck item for a person, and checked each hour after.
// Idempotent: a check is written only by the lease's holder, and only while the job is on the same wait. A hopper that stops
// mid-check holds its lease until it ends (`LEASE_MS`); then any hopper on the same database takes the check. Part 2: a
// time the job named ends the wait at it, whatever its condition says; a wait on a pull request's checks reads them. Part 3:
// a wait on a pull request's review reads its reviews. Issue #2335: a recheck wakes the job at its time to look again.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Clock, ExecutorRegistry, UserStore } from '../domain/ports.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import { afterCheck, checkEndedNote, checksOutcome, commandOutcome, conditionKey, newCheck, recheckOutcome, refLabel, reviewOutcome, type CheckOutcome, type WaitCheck, type WaitedChecks, type WaitedReviews } from '../domain/wait-checks.ts';
import { waitOnLabel } from '../domain/wait-on.ts';
import { endedBeforeWait, endedNote, NOT_FOUND, watchKey, type WatchedEnd, type WatchedRef } from '../domain/watched-items.ts';
import { recordEndWait } from './wait.ts';

/** How long a hopper holds a wait check it tests. */
export const LEASE_MS = 2 * 60_000;

/** The reads a check needs, as the job's source reads them; undefined, it cannot read now: the items of `refs` that ended; a pull request's checks (part 2); its reviews (part 3), undefined when the job's source reads no pull request and a throw when the read failed (issue #2210). */
export interface WaitReads {
  endedWatched(job: Job, refs: WatchedRef[]): Promise<WatchedEnd[] | undefined>;
  pullRequestChecks?(job: Job, repo: string, number: number): Promise<WaitedChecks | undefined>;
  pullRequestReviews?(job: Job, repo: string, number: number): Promise<WaitedReviews | undefined>;
}

export interface WaitCheckDeps {
  store: UserStore;
  clock: Clock;
  executors: ExecutorRegistry;
  stopping(): boolean;
  trigger(reason: string): void;
  ownCommandGraceMs: number;
  waitReads?: WaitReads;
}

export interface WaitChecks {
  /** One pass: each job on its own wait gets its check, and each check due is tested. A pass while one runs does nothing. */
  run(): Promise<void>;
}

const QUESTION_ENDS: Record<string, string> = { answered: 'was answered', closed: 'was closed', dismissed: 'was dismissed', expired: 'expired', lapsed: 'lapsed', cancelled: 'was cancelled' };

export function createWaitChecks(c: WaitCheckDeps, o: { owner?: string } = {}): WaitChecks {
  const { store } = c;
  const owner = o.owner ?? `${hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;
  let busy = false;
  const nowMs = () => c.clock.now().getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  /** The condition the hopper last woke the job for, read from its last `job.wait_ended`. */
  const wokenFor = (jobId: string): string | undefined => {
    const d = store.events.recent(1, ['job.wait_ended'], jobId)[0]?.data as { check?: unknown } | undefined;
    return typeof d?.check === 'string' ? d.check : undefined;
  };

  /** In a tx: the job's wait gets its check, unless it has one. The job as it is now. */
  function ensureCheck(job: Job): Job {
    return store.tx(() => {
      const now = store.jobs.get(job.id);
      if (now?.status !== 'waiting_on' || !now.wait || now.wait.check) return now ?? job;
      return store.jobs.update(job.id, { wait: { ...now.wait, check: newCheck(now, nowMs(), wokenFor(job.id)) } });
    });
  }

  /** The check's condition, else the time the job named, when it passed. */
  async function test(job: Job, check: WaitCheck): Promise<CheckOutcome> {
    const outcome = await testCondition(job, check);
    if (outcome.met || !check.wakeAt || nowMs() < Date.parse(check.wakeAt)) return outcome;
    return { met: true, note: `the time you named passed (${iso(nowMs())}); ${outcome.result}` };
  }

  /** A pull request a check reads (issue #2210): what `read` answers, else why not — the job's source reads none, or the read's error. Tried again at the next check. */
  async function readPull<T>(at: { repo: string; number: number }, read: () => Promise<T | undefined> | undefined): Promise<T | { met: false; result: string }> {
    const what = `${at.repo}#${at.number}`;
    try {
      return (await read()) ?? { met: false, result: `the job's source reads no pull request, so the hopper cannot read ${what}` };
    } catch (e) {
      return { met: false, result: `the hopper cannot read ${what} now: ${(e as Error).message}` };
    }
  }

  async function testCondition(job: Job, check: WaitCheck): Promise<CheckOutcome> {
    const cond = check.condition;
    switch (cond.kind) {
      case 'items_ended': {
        const ended = await c.waitReads?.endedWatched(job, cond.refs).catch(() => undefined);
        if (!ended) return { met: false, result: 'the hopper cannot read the items now' };
        const missing = ended.filter((e) => e.state === NOT_FOUND);
        if (missing.length) return { met: true, note: endedNote(missing) };
        // Issue #2219: what an outside wait's text names that ended before the wait began does not end it.
        const before = ended.filter((e) => endedBeforeWait(job, e));
        const stale = new Set(before.map((e) => watchKey(e.ref)));
        const refs = cond.refs.filter((r) => !stale.has(watchKey(r)));
        if (refs.length === 0) return { met: false, result: `ended before the wait began: ${before.map((e) => refLabel(e.ref)).join(', ')}` };
        const keys = new Set(ended.map((e) => `${e.ref.repo.toLowerCase()}#${e.ref.kind === 'issue' ? e.ref.number : e.ref.runId}`));
        const open = refs.filter((r) => !keys.has(`${r.repo.toLowerCase()}#${r.kind === 'issue' ? r.number : r.runId}`));
        return open.length === 0 ? { met: true, note: endedNote(ended.filter((e) => !stale.has(watchKey(e.ref)))) } : { met: false, result: `not ended yet: ${open.map(refLabel).join(', ')}` };
      }
      case 'job_ended': {
        const other = store.jobs.get(cond.jobId);
        if (!other) return { met: true, note: `job ${cond.jobId} is gone` };
        return TERMINAL_STATUSES.includes(other.status) ? { met: true, note: `job ${cond.jobId} ${other.status}` } : { met: false, result: `job ${cond.jobId} is ${other.status}` };
      }
      case 'question_settled': {
        const q = store.questions.get(cond.questionId);
        const ends = q ? QUESTION_ENDS[q.status] : 'is gone';
        return ends ? { met: true, note: `question ${cond.questionId} ${ends}` } : { met: false, result: `question ${cond.questionId} is open` };
      }
      case 'command_exited': {
        const executor = c.executors.get(job.spec.executor);
        const lost = executor?.paneLost ? await executor.paneLost(job).catch(() => null) : null;
        const runs = executor?.ownCommandRuns ? await executor.ownCommandRuns(job).catch(() => null) : null;
        return commandOutcome(job.wait!, { runs, lost }, nowMs(), c.ownCommandGraceMs);
      }
      case 'pr_checks_ended': {
        const pr = await readPull(cond, () => c.waitReads?.pullRequestChecks?.(job, cond.repo, cond.number));
        return 'result' in pr ? pr : checksOutcome(pr, nowMs());
      }
      case 'pr_review_ended': {
        const pr = await readPull(cond, () => c.waitReads?.pullRequestReviews?.(job, cond.repo, cond.number));
        return 'result' in pr ? pr : reviewOutcome(pr, Date.parse(job.wait!.since));
      }
      case 'time_passed':
        return nowMs() >= Date.parse(cond.at) ? { met: true, note: `the time you named passed (${iso(nowMs())})` } : { met: false, result: `it waits until ${cond.at}` };
      case 'recheck':
        return recheckOutcome(cond, job.wait!, nowMs());
      case 'none':
        return { met: false, result: `the hopper has no check for ${job.wait?.on ? waitOnLabel(job.wait.on) : 'this wait'}` };
    }
  }

  /** In a tx, while this hopper holds the lease and the job is on the same wait: what `outcome` makes of the check. True when it woke the job. */
  function settle(job: Job, check: WaitCheck, outcome: CheckOutcome): boolean {
    return store.tx(() => {
      const now = store.jobs.get(job.id);
      if (now?.status !== 'waiting_on' || now.wait?.since !== job.wait?.since || !store.waitCheckLeases.holds(job.id, owner)) return false;
      if (outcome.met && !check.repeat) {
        const key = conditionKey(check.condition);
        recordEndWait(c, job.id, outcome.note, 'hopper', (w) => outcome.told ?? checkEndedNote(w, outcome.note), { check: key });
        return true;
      }
      const result = outcome.met ? `${outcome.note} before this wait began; the hopper woke the job for it once` : outcome.result;
      const next = afterCheck(check, result, nowMs(), outcome.met);
      store.jobs.update(job.id, { wait: { ...now.wait!, check: next.check } });
      if (next.overdue) store.events.append({ type: 'job.wait_overdue', jobId: job.id, data: { deadline: check.deadline, result } });
      return false;
    });
  }

  async function checkOne(job: Job): Promise<boolean> {
    const check = job.wait?.check;
    if (!check || Date.parse(check.nextCheckAt) > nowMs()) return false;
    if (!store.waitCheckLeases.claim(job.id, job.wait!.since, owner, LEASE_MS)) return false;
    try {
      const outcome = await test(job, check);
      return !c.stopping() && settle(job, check, outcome);
    } finally {
      if (!c.stopping()) store.waitCheckLeases.release(job.id, owner);
    }
  }

  return {
    async run() {
      if (busy || c.stopping()) return;
      busy = true;
      let woke = false;
      try {
        for (const listed of store.jobs.list({ status: ['waiting_on'] })) {
          if (c.stopping()) break;
          try {
            const job = ensureCheck(listed);
            if (job.status === 'waiting_on' && (await checkOne(job))) woke = true;
          } catch (e) {
            console.error(`hopper: the wait check of job ${listed.id} failed, tried again at the next pass`, e);
          }
        }
      } finally {
        busy = false;
      }
      if (woke) c.trigger('job.wait_ended');
    },
  };
}
