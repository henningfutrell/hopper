// The done-check backfill (issue #637, design.md "The done-check backfill"): each `not complete:` failure that waits on a
// person — its hand-off open, or its record not settled —, the newest job of its item, judged again by today's done rule
// (`doneAtSource`). Done: its job ends finished — PR waiting when a pull request of it is still open (its report follows
// it), else finished —, its hand-off closes and its record turns `resolved`, in one transaction with one event, the
// job's `job.finished` (`result.backfill`). Its issue is not reopened and nothing runs again. Not done, or not known: it
// stays in Failures, with its card's plain sentence. Idempotent: a job it changed is no longer failed. It runs once at
// the first start of a build that has it (`backfills` in the user's settings), and whenever it is asked.
import type { UserStore } from '../domain/ports.ts';
import type { FailureOutcome, Job, WorkState } from '../domain/types.ts';
import { handoffCard } from './card.ts';
import { BUILTIN_CAUSES } from './causes.ts';
import { RAN_AGAIN, SETTLED } from './handoff.ts';

export const DONE_CHECK_BACKFILL = 'done-check';
export const BACKFILL_NOTE = 'done at its source, found by the done-check backfill: its issue is closed as completed, or a pull request of it is ready or merged';

export interface BackfillResult {
  backfill: typeof DONE_CHECK_BACKFILL;
  /** Each job it changed, and its state now: finished, or PR waiting (a pull request of it still open). */
  changed: { jobId: string; state: 'finished' | 'pr-waiting' }[];
  /** How many it looked at and left as they were. */
  unchanged: number;
  /** Each it left in Failures, and why, in a plain sentence. */
  failures: { jobId: string; reason: string }[];
}

export interface BackfillOptions {
  store: UserStore;
  now(): Date;
  /** Whether the job's work is done at its source. Throws: not known. */
  doneAtSource?(job: Job): Promise<boolean>;
  /** What the job's work shows at its source: whether its issue is closed as completed. Throws: not known. */
  workState(job: Job): Promise<Omit<WorkState, 'checkedAt'> | undefined>;
  /** Finish a failed job whose work shipped, its end told to its source again. False: it is no longer failed. */
  finishShipped(jobId: string, result: { summary: string; backfill: string }): boolean;
  live(): boolean;
  logger: { warn(line: string): void };
}

const NOT_COMPLETE = BUILTIN_CAUSES.find((c) => c.id === 'not-complete')!.pattern;

/** A sentence: a capital first, a full stop last. */
const sentence = (text: string): string => {
  const t = text.trim().split('\n', 1)[0]!.replace(/[.:\s]+$/, '');
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
};

/** A record that still waits: no run again made, nothing settled it. */
const waits = (r: { outcome?: FailureOutcome } | undefined): boolean => r !== undefined && (r.outcome === undefined || ![...RAN_AGAIN, ...SETTLED].includes(r.outcome));

export function createBackfill(o: BackfillOptions) {
  const { store } = o;

  /** The done-check misses that wait on a person: the newest job of the item, its hand-off open or its record unsettled. */
  function misses(): Job[] {
    return store.jobs.list({ status: ['failed'] }).filter((j) => {
      if (!NOT_COMPLETE.test(j.error ?? '')) return false;
      if (j.source && store.jobs.getBySourceKey(j.source.key)?.id !== j.id) return false;
      return store.handoffs.forJob(j.id)?.status === 'open' || waits(store.failures.forJob(j.id));
    });
  }

  function reasonOf(job: Job, why?: string): string {
    if (why) return sentence(why);
    const h = store.handoffs.forJob(job.id);
    return h?.status === 'open' ? handoffCard(h, false).whatHappened : sentence(job.error ?? 'the job failed');
  }

  /** Finish the job, close its hand-off and settle its record: one transaction, one event. False: it changed meanwhile. */
  function finish(job: Job): boolean {
    return store.tx(() => {
      if (store.jobs.get(job.id)?.status !== 'failed') return false;
      const at = o.now().toISOString();
      const h = store.handoffs.forJob(job.id);
      if (h?.status === 'open') store.handoffs.update(h.id, { status: 'closed', closedAt: at, end: 'finished' });
      const r = store.failures.forJob(job.id);
      if (r && waits(r)) {
        store.failures.update(r.id, { pending: undefined, pendingAt: undefined, outcome: 'resolved', outcomeAt: at, note: BACKFILL_NOTE });
      }
      return o.finishShipped(job.id, { summary: BACKFILL_NOTE, backfill: DONE_CHECK_BACKFILL });
    });
  }

  /** One pass. `unknown`: how many its source could not tell about — a start that met one runs it again next start. */
  async function run(): Promise<BackfillResult & { unknown: number }> {
    const out: BackfillResult & { unknown: number } = { backfill: DONE_CHECK_BACKFILL, changed: [], unchanged: 0, failures: [], unknown: 0 };
    if (!o.doneAtSource) return out;
    for (const job of misses()) {
      if (!o.live()) break;
      let done: boolean;
      let open = false;
      try {
        done = await o.doneAtSource(job);
        if (done) open = (await o.workState(job))?.item === 'open';
      } catch (e) {
        out.unknown++;
        out.unchanged++;
        out.failures.push({ jobId: job.id, reason: reasonOf(job, `the hopper could not tell whether its work is done: ${e instanceof Error ? e.message : String(e)}`) });
        continue;
      }
      if (done && o.live() && finish(job)) out.changed.push({ jobId: job.id, state: open ? 'pr-waiting' : 'finished' });
      else {
        out.unchanged++;
        out.failures.push({ jobId: job.id, reason: reasonOf(job) });
      }
    }
    return out;
  }

  return {
    /** Asked from the UI or the operator CLI: one pass, whatever ran before. */
    async run(): Promise<BackfillResult> {
      const { unknown: _u, ...r } = await run();
      return r;
    },
    /** At start: one pass unless one completed before on this store; marked once its source could tell about each. */
    async once(): Promise<void> {
      if (store.settings.getBackfills()[DONE_CHECK_BACKFILL] !== undefined) return;
      try {
        const r = await run();
        if (r.unknown === 0 && o.live()) store.settings.setBackfills({ ...store.settings.getBackfills(), [DONE_CHECK_BACKFILL]: o.now().toISOString() });
        else if (r.unknown > 0) o.logger.warn(`hopper: the done-check backfill could not tell about ${r.unknown} failed jobs; it runs again at the next start`);
      } catch (e) {
        o.logger.warn(`hopper: the done-check backfill did not complete, it runs again at the next start: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}
