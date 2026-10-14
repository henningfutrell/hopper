// Run again, the sync loop's half (issues #313, #354; a rejected job too, issue #387; with a brief, and Continue, issue #551;
// Rework, issue #724, a done job's open pull request sent back with notes): an ended job's source gives its item back
// (`JobSource.rerun` — on GitHub a closed issue is reopened and the end labels go) and the new job is
// queued in the same step (`SourceHost.rerun`), so the user sees it at once. The sync loop (sync.ts)
// hands it the job's report chain.

import type { JobSource, RerunBy, RerunResult, SourceHost, SourceItem } from '../domain/ports.ts';
import { RerunRefused } from '../domain/rerun-refused.ts';
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
    await c.enqueue(jobId, async () => {
      const source = check(jobId, rework, tending, ends);
      if ('ok' in source) { result = source; return; }
      let given: G;
      try {
        given = await give(source, store.jobs.get(jobId)!);
      } catch (e) {
        result = e instanceof RerunRefused ? conflict(jobId, e.message) : { ok: false, reason: 'source', message: `its source could not give the item back: ${message(e)}` };
        return;
      }
      // Who edited it since its snapshot, read before the new job is made: the job runs the snapshot's text (issue #662).
      result = then(await withEdits(c.host, source, given.item), source, given);
    });
    // The new job's claim is reported at once, not at the next poll.
    if (result.ok) c.syncSoon(checked);
    return result;
  }

  return {
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
    /** Rework (issue #724): the pull request made a draft and the item given back, and a new job queued, told the notes. */
    rework(jobId: string, notes: string, acting?: ActingPerson): Promise<RerunResult> {
      return takeBack<Reworked>(jobId, (item, source, given) => ({
        ok: true, job: c.host.rework(jobId, item, sourceRef(source), { pullRequest: given.pullRequest, notes, state: given.state }, acting),
      }), (source, job) => source.rework!(job), true);
    },
  };
}
