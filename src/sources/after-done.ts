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
// Tending (issue #736): a followed pull request that, as last seen, has merge conflicts or failing checks is not left for a
// person. After its follow, off the report chain, the job's item runs again (`tend`, Run again by `tending`) with the tend
// brief; the job follows it no more (`follow: tended`) and `job.pull_request_tended` names the new job, which brings the
// same pull request back to ready, or fails saying why and waits on a person. At most `MAX_TENDS` in a row of one pull
// request. A refusal because a newer job of the item exists is no failure; any other is kept as a retry.
import type { JobSource, PullRequestActResult, RerunResult, SourceHost, UserStore } from '../domain/ports.ts';
import { SourceError } from '../domain/ports.ts';
import {
  following, judge, MAX_TENDS, rechecksMerge, tendBrief, tendsInRow, tendStep,
  type ActingPerson, type FollowUp, type Job, type PullRequestAct, type PullRequestSeen, type Tended,
} from '../domain/types.ts';

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
  /** Run the job's item again with `brief`, by `tending` (issue #736): Run again's own path, off the report chain. */
  tend(jobId: string, brief: string): Promise<RerunResult>;
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

  /** Its followed pull request needs tending (issue #736), and it may be: the step, and its URL; else undefined. */
  function tendDue(job: Job | undefined): { step: NonNullable<ReturnType<typeof tendStep>>; url: string } | undefined {
    if (!job || job.status !== 'finished' || !following(job)) return undefined;
    const s = job.sourceState?.source as { pullRequest?: string; seen?: PullRequestSeen } | undefined;
    const step = tendStep(s?.seen);
    if (!step || !s?.pullRequest) return undefined;
    if (tendsInRow(job, s.pullRequest, (id) => store.jobs.get(id)) >= MAX_TENDS) return undefined;
    return { step, url: s.pullRequest };
  }

  /** Tend the job's followed pull request when it needs it (issue #736): its item runs again with the tend brief. */
  async function tendIfDue(jobId: string): Promise<void> {
    const due = tendDue(store.jobs.get(jobId));
    if (!due) return;
    const r = await c.tend(jobId, tendBrief(due.url, due.step));
    if (!r.ok) {
      if (r.reason !== 'conflict') c.failed(jobId, new Error(r.message));
      return;
    }
    const job = store.jobs.get(jobId);
    if (!job) return;
    const tended: Tended = { pullRequest: due.url, step: due.step, nextJobId: r.job.id };
    c.setSource(jobId, { ...(job.sourceState?.source ?? {}), follow: 'tended', tended });
    store.events.append({ type: 'job.pull_request_tended', jobId, data: { pullRequest: due.url, step: due.step, nextJobId: r.job.id } });
  }

  const waitsOnPerson = (j: Job) => j.status === 'failed' && NOT_COMPLETE.test(j.error ?? '') && store.handoffs.forJob(j.id)?.status === 'open';

  return {
    act,
    /** One sync of the source: every job of its to follow, or to judge again. */
    async catchUp(source: JobSource, jobs: Job[]): Promise<void> {
      const run = (j: Job, fn: (s: JobSource, id: string) => Promise<void>) =>
        c.enqueue(j.id, () => fn(source, j.id).catch((e: unknown) => { c.failed(j.id, e); }));
      // A tend runs after the follow, off the report chain: Run again takes that chain itself.
      await Promise.all(jobs.filter((j) => c.finalReported(j)).flatMap((j) =>
        (j.status === 'finished' && source.follow && (following(j) || rechecks(j)) ? [run(j, follow).then(() => tendIfDue(j.id).catch((e: unknown) => { c.failed(j.id, e); }))] : waitsOnPerson(j) ? [run(j, judgeAgain)] : [])));
    },
  };
}
