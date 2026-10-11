// After done (issue #579), the sync loop's half, at each sync of a source, on each job's report chain. A finished job
// whose pull request its report kept to follow is asked of its source (`JobSource.follow`): merged or closed without a
// merge is recorded (`job.pull_request_merged`, `job.pull_request_closed`) with the source state it leaves; still open,
// what was seen of it is kept, with no event (issue #637). A merge recorded as the whole item before issue #721 is asked
// once more (`rechecksMerge`), for the newest job of its item only: a part after all is recorded again as a part. And a job
// that failed only for want of a merged pull request — `not complete:`, from before a pull request was done — and still
// waits on a person is judged again: done or partly done now, it is finished (its hand-off closes on `job.finished`) and
// its end reported again, so its issue loses `hopper:failed`. A throw is kept as a retry and asked again next sync.
// A person's Merge now or Close PR (issue #677) is the same follow, with the act, on the same chain: recorded the same
// way, with who pressed it; a throw goes back to the person.
import type { JobSource, PullRequestActResult, SourceHost, UserStore } from '../domain/ports.ts';
import { SourceError } from '../domain/ports.ts';
import { following, judge, rechecksMerge, type ActingPerson, type FollowUp, type Job, type PullRequestAct } from '../domain/types.ts';

export interface AfterDoneContext {
  store: Pick<UserStore, 'jobs' | 'events' | 'handoffs'>;
  host: Pick<SourceHost, 'finishComplete'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  /** Whether the job's end is reported to its source. */
  finalReported(job: Job): boolean;
  /** Keep the job's new source state. */
  setSource(jobId: string, source: Record<string, unknown>): void;
  /** Report the job's end again: a finish replaced its reported failure. */
  reportAgain(jobId: string): void;
  /** Asking the source failed: kept as the job's retry. */
  failed(jobId: string, e: unknown): void;
}

const NOT_COMPLETE = /^not complete: /;

export function createAfterDone(c: AfterDoneContext) {
  const { store } = c;

  /** Only the newest job of its item is checked again: an older one's merge never takes off a later job's `hopper:done`. */
  const rechecks = (j: Job) => rechecksMerge(j) && (!j.source || store.jobs.getBySourceKey(j.source.key)?.id === j.id);

  /** Keep what following found, and record a merge or a close: by the hopper, by `acting`, or as seen on GitHub. */
  function record(jobId: string, r: FollowUp, acting?: ActingPerson): void {
    c.setSource(jobId, r.state);
    if (r.outcome === 'open' || r.outcome === 'checked') return;
    store.events.append({
      type: r.outcome === 'merged' ? 'job.pull_request_merged' : 'job.pull_request_closed', jobId,
      data: { pullRequest: r.pullRequest, part: r.part, ...(r.byHopper ? { byHopper: true } : {}), ...(acting ? { person: acting.person, via: acting.via } : {}) },
    });
  }

  async function follow(source: JobSource, jobId: string): Promise<void> {
    const job = store.jobs.get(jobId);
    if (!job || !(following(job) || rechecks(job))) return;
    const r = await source.follow!(job);
    if (r) record(jobId, r);
  }

  /** A person's Merge now or Close PR (issue #677), on the job's report chain. */
  async function act(jobId: string, what: PullRequestAct, acting: ActingPerson): Promise<PullRequestActResult> {
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    const source = c.sourceOf(job);
    if (!source?.follow) return { ok: false, reason: 'conflict', message: `job ${jobId}: its source is not running, or follows no pull request` };
    let result: PullRequestActResult = { ok: false, reason: 'source', message: 'not sent' };
    await c.enqueue(jobId, async () => { result = await actOn(source, jobId, what, acting); });
    return result;
  }

  /** Asked of the source with the act, then recorded as a follow is; a throw goes back to the person. */
  async function actOn(source: JobSource, jobId: string, what: PullRequestAct, acting: ActingPerson): Promise<PullRequestActResult> {
    const job = store.jobs.get(jobId);
    if (!job || !following(job)) return { ok: false, reason: 'conflict', message: `job ${jobId} has no open pull request` };
    try {
      const r = await source.follow!(job, what);
      if (!r) return { ok: false, reason: 'conflict', message: `job ${jobId} has no open pull request` };
      record(jobId, r, acting);
      return { ok: true, outcome: r.outcome, pullRequest: r.pullRequest, part: r.part };
    } catch (e) {
      const refused = e instanceof SourceError && e.permanent;
      return { ok: false, reason: refused ? 'conflict' : 'source', message: `${what === 'merge' ? 'merge' : 'close'} refused: ${(e as Error).message}` };
    }
  }

  async function judgeAgain(source: JobSource, jobId: string): Promise<void> {
    const job = store.jobs.get(jobId);
    if (job?.status !== 'failed') return;
    const v = await judge(source, job);
    if (!v.done && !('partlyDone' in v)) return;
    if (c.host.finishComplete(jobId, 'partlyDone' in v ? v.partlyDone : undefined)) c.reportAgain(jobId);
  }

  const waitsOnPerson = (j: Job) => j.status === 'failed' && NOT_COMPLETE.test(j.error ?? '') && store.handoffs.forJob(j.id)?.status === 'open';

  return {
    act,
    /** One sync of the source: every job of its to follow, or to judge again. */
    async catchUp(source: JobSource, jobs: Job[]): Promise<void> {
      const run = (j: Job, fn: (s: JobSource, id: string) => Promise<void>) =>
        c.enqueue(j.id, () => fn(source, j.id).catch((e: unknown) => { c.failed(j.id, e); }));
      await Promise.all(jobs.filter((j) => c.finalReported(j)).flatMap((j) =>
        (j.status === 'finished' && source.follow && (following(j) || rechecks(j)) ? [run(j, follow)] : waitsOnPerson(j) ? [run(j, judgeAgain)] : [])));
    },
  };
}
