// Run again, the sync loop's half (issues #313, #354; a rejected job too, issue #387; with a brief, and Continue, issue #551;
// Rework, issue #724, a done job's open pull request sent back with notes): an ended job's source gives its item back
// (`JobSource.rerun` — on GitHub a closed issue is reopened and the end labels go) and the new job is
// queued in the same step (`SourceHost.rerun`), so the user sees it at once. The sync loop (sync.ts)
// hands it the job's report chain. A person's act that gives an item back (issue #1194: Run again and Rework, `giveBack`;
// Retry, a hand-off's Continue and I fixed it, Push it and Tend again, `afterAnswer`) answers once the checks the hopper
// can make now pass; the source's give-back and the new job run after, on that chain, and a give-back that fails is
// recorded (`job.give_back_failed`).

import type { JobSource, RerunBy, RerunResult, SourceHost, SourceItem } from '../domain/ports.ts';
import type { GiveBackAct, GiveBackAnswer, GiveBackChecked, GiveBackRun } from '../domain/give-back.ts';
import { RerunRefused } from '../domain/rerun-refused.ts';
import { withAct } from './after-answer-timings.ts';
import { sourceRef, withEdits } from './item-text.ts';
import { following, PUSHABLE_ENDS, tendRetryAt, type ActingPerson, type Allowed, type ContinuedBy, type Job, type JobStatus, type Tended } from '../domain/types.ts';

export interface RerunContext {
  host: SourceHost;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  flagsOf(job: Job): { finalReported?: boolean };
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Sync the source at once, not waiting for the result. */
  syncSoon(source: JobSource): void;
}

/** The ends Run again takes. */
const RERUN_ENDS: readonly JobStatus[] = ['failed', 'finished', 'rejected'];

type Reworked = Awaited<ReturnType<NonNullable<JobSource['rework']>>>;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRerun(c: RerunContext) {
  const store = c.host.store;
  const conflict = (jobId: string, why: string): RerunResult => ({ ok: false, reason: 'conflict', message: `job ${jobId} cannot run again: ${why}` });

  /**
   * Why an ended job's item cannot run again now — or, `rework`, be sent back for rework (issue #724) —, or its source.
   * `tending` (issue #1010): a newer job of its item may exist when it is the job's own tend job, cancelled by no person
   * and no source: the tend runs again. `ends`: the ends taken, Push it's too (issue #1010) for a Continue with kept work.
   */
  function check(jobId: string, rework = false, tending = false, ends: readonly JobStatus[] = RERUN_ENDS): RerunResult | JobSource {
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    if (rework) {
      if (job.status !== 'finished') return conflict(jobId, `it is ${job.status}: only a finished job's pull request is sent back for rework`);
      if (!following(job)) return conflict(jobId, 'it follows no open pull request to rework');
    }
    if (!ends.includes(job.status)) return conflict(jobId, `it is ${job.status}, not ${ends.join(', ').replace(/, ([^,]+)$/, ' or $1')}`);
    const source = c.sourceOf(job);
    const taken = takesBackOf(job, source);
    if (!taken.ok || !source) return conflict(jobId, taken.ok ? 'its source is not running' : taken.why);
    if (rework && !source.rework) return conflict(jobId, `its source ${source.name} cannot rework a pull request`);
    const newest = store.jobs.getBySourceKey(job.source!.key);
    const retried = tending && tendRetryAt((job.sourceState?.source as { tended?: Tended } | undefined)?.tended, newest) !== undefined;
    if (newest?.id !== jobId && !retried) return conflict(jobId, 'a newer job of its item exists');
    return source;
  }

  /** Whether the job's source takes its item back now: it runs, it can run an item again, and the job's end is reported to it. */
  function takesBackOf(job: Job, source: JobSource | undefined): Allowed {
    if (!source) return { ok: false, why: 'its source is not running: turn it on in Sources' };
    if (!source.rerun) return { ok: false, why: `its source ${source.name} cannot run an item again` };
    if (!c.flagsOf(job).finalReported) return { ok: false, why: 'its end is not reported to its source yet', soon: true };
    return { ok: true };
  }

  /**
   * The item given back by its source (`give`: for Run again, `rerun`), then `then` with it and what `give` answered
   * besides, on the job's report chain.
   */
  async function takeBack<G extends { item: SourceItem }>(
    jobId: string, then: (item: SourceItem, source: JobSource, given: G) => RerunResult,
    give: (source: JobSource, job: Job) => Promise<G> = async (source, job) => ({ item: await source.rerun!(job) }) as G, rework = false, tending = false,
    ends: readonly JobStatus[] = RERUN_ENDS,
  ): Promise<RerunResult> {
    const checked = check(jobId, rework, tending, ends);
    if ('ok' in checked) return checked;
    let result: RerunResult = { ok: false, reason: 'source', message: 'not sent' };
    const giveAndThen = async (): Promise<RerunResult> => {
      const source = check(jobId, rework, tending, ends);
      if ('ok' in source) return source;
      let given: G;
      try {
        given = await give(source, store.jobs.get(jobId)!);
      } catch (e) {
        return e instanceof RerunRefused ? conflict(jobId, e.message) : { ok: false, reason: 'source', message: `its source could not give the item back: ${message(e)}` };
      }
      // Who edited it since its snapshot, read before the new job is made: the job runs the snapshot's text (issue #662).
      return then(await withEdits(c.host, source, given.item), source, given);
    };
    await c.enqueue(jobId, async () => {
      try {
        result = await giveAndThen();
      } catch (e) {
        result = { ok: false, reason: 'source', message: message(e) };
      }
    });
    // The new job's claim is reported at once, not at the next poll.
    if (result.ok) c.syncSoon(checked);
    return result;
  }

  const rework = (jobId: string, notes: string, acting?: ActingPerson): Promise<RerunResult> =>
    takeBack<Reworked>(jobId, (item, source, given) => ({
      ok: true, job: c.host.rework(jobId, item, sourceRef(source), { pullRequest: given.pullRequest, notes, state: given.state }, acting),
    }), (source, job) => source.rework!(job), true);

  /** Each ended job's give-back under way after a person's answer (issue #1194), until it ends. */
  const givingBack = new Map<string, GiveBackAct>();

  /**
   * The answer to a person's act that passed its checks: `run` goes on after it, and one that fails records
   * `job.give_back_failed` with why. The same job's act sent again while one runs (a second click, another tab) answers
   * that one, and runs nothing more.
   */
  function answer(jobId: string, act: GiveBackAct, run: () => Promise<GiveBackRun>, acting?: ActingPerson): GiveBackAnswer {
    const running = givingBack.get(jobId);
    if (running) return { ok: true, jobId, giveBack: running };
    givingBack.set(jobId, act);
    void withAct(act, run).catch((e: unknown): GiveBackRun => ({ ok: false, message: message(e) })).then((r) => {
      givingBack.delete(jobId);
      if (!r.ok) store.tx(() => store.events.append({ type: 'job.give_back_failed', jobId, data: { act, error: r.message, ...acting } }));
    }).catch((e: unknown) => console.warn(`hopper: the give-back of job ${jobId} ended, but could not be recorded: ${message(e)}`));
    return { ok: true, jobId, giveBack: act };
  }

  return {
    /**
     * A person's Run again or Rework (issue #1194): the checks the hopper can make now, then the answer; the source gives
     * the item back after, on the job's report chain, and the new job follows (`job.rerun`, `job.rework_requested`). One
     * that fails records `job.give_back_failed` with why, and makes no job. The same act sent again while one runs (a second
     * click, another tab) answers that one.
     */
    giveBack(jobId: string, act: { kind: 'rerun' } | { kind: 'rework'; notes: string }, acting?: ActingPerson): GiveBackAnswer {
      const running = givingBack.get(jobId);
      if (running) return { ok: true, jobId, giveBack: running };
      const checked = check(jobId, act.kind === 'rework');
      if ('ok' in checked && !checked.ok) return { ok: false, reason: checked.reason === 'not_found' ? 'not_found' : 'conflict', message: checked.message };
      const run = () => (act.kind === 'rework' ? rework(jobId, act.notes, acting)
        : takeBack(jobId, (item, source) => ({ ok: true, job: c.host.rerun(jobId, item, sourceRef(source), 'user', undefined, acting) })));
      return answer(jobId, act.kind, run, acting);
    },
    /**
     * A person's Retry, a hand-off's Continue or I fixed it, Push it or Tend again (issue #1194, part 4), `checked` by its
     * own service: refused at once with why, else answered, its give-back and what follows run after, as `giveBack`'s.
     */
    afterAnswer(act: GiveBackAct, checked: GiveBackChecked, acting?: ActingPerson): GiveBackAnswer {
      return checked.ok ? answer(checked.jobId, act, checked.run, acting) : checked;
    },
    /** Whether its source takes the job's item back now (issue #1010), as Run again, Continue and Push it need: the views offer only that. */
    takesBack(jobId: string): Allowed {
      const job = store.jobs.get(jobId);
      return job ? takesBackOf(job, c.sourceOf(job)) : { ok: false, why: 'its job is gone' };
    },
    rerun(jobId: string, by: RerunBy = 'user', brief?: string, acting?: ActingPerson): Promise<RerunResult> {
      return takeBack(jobId, (item, source) => ({ ok: true, job: c.host.rerun(jobId, item, sourceRef(source), by, brief, acting) }), undefined, false, by === 'tending');
    },
    /** Continue (issue #551): the item given back as for Run again, and the same job queued again to resume its session. */
    continueJob(jobId: string, brief: string, by: ContinuedBy): Promise<RerunResult> {
      return takeBack(jobId, () => c.host.continueJob(jobId, brief, by), undefined, false, false, 'keptWork' in by ? PUSHABLE_ENDS : RERUN_ENDS);
    },
  };
}
