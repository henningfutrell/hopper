// A person's Merge now or Close PR (issue #677, after-done.ts) on a finished job's open pull request. Answered at once
// (issue #1194, design.md "Actions answer at once"): the checks the hopper can make itself — the job, its source running
// and following pull requests, the job following an open one —, then the answer. After it, on the job's report chain,
// the source merges the pull request or closes it without a merge, and that is recorded as a follow is, with who pressed
// it; one GitHub refuses, or that cannot reach GitHub, records `job.pull_request_act_failed` with why. The same job's act
// sent again while one runs (a second click, another tab, the CLI) answers that one. Kept in memory, as a give-back is.
import type { JobSource, PullRequestActAnswer, UserStore } from '../domain/ports.ts';
import { following, type ActingPerson, type FollowUp, type Job, type PullRequestAct } from '../domain/types.ts';

export interface PullRequestActsContext {
  store: Pick<UserStore, 'jobs' | 'events'>;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Keep what the source answered, and record the merge or the close, by `acting`. */
  record(jobId: string, r: FollowUp, acting: ActingPerson): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createPullRequestActs(c: PullRequestActsContext) {
  const { store } = c;
  /** Each job's act under way after its answer, until it ends. */
  const acting = new Map<string, PullRequestAct>();
  const noPullRequest = (jobId: string) => `job ${jobId} has no open pull request`;

  /** The act asked of the source, then recorded: why it failed, or undefined. */
  async function run(source: JobSource, jobId: string, what: PullRequestAct, person: ActingPerson): Promise<string | undefined> {
    const job = store.jobs.get(jobId);
    if (!job || !following(job)) return noPullRequest(jobId);
    try {
      const r = await source.follow!(job, what);
      if (!r) return noPullRequest(jobId);
      c.record(jobId, r, person);
      return undefined;
    } catch (e) {
      return `${what === 'merge' ? 'merge' : 'close'} refused: ${message(e)}`;
    }
  }

  return function act(jobId: string, what: PullRequestAct, person: ActingPerson): PullRequestActAnswer {
    const running = acting.get(jobId);
    if (running) return { ok: true, jobId, act: running };
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    const source = c.sourceOf(job);
    if (!source?.follow) return { ok: false, reason: 'conflict', message: `job ${jobId}: its source is not running, or follows no pull request` };
    if (!following(job)) return { ok: false, reason: 'conflict', message: noPullRequest(jobId) };
    acting.set(jobId, what);
    let error: string | undefined;
    void c.enqueue(jobId, async () => { error = await run(source, jobId, what, person); })
      .catch((e: unknown) => { error = message(e); })
      .then(() => {
        acting.delete(jobId);
        if (error !== undefined) store.events.append({ type: 'job.pull_request_act_failed', jobId, data: { act: what, error, ...person } });
      })
      .catch((e: unknown) => console.warn(`hopper: the ${what} of job ${jobId}'s pull request ended, but could not be recorded: ${message(e)}`));
    return { ok: true, jobId, act: what };
  };
}
