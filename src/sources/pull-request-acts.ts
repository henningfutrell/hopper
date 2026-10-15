// A person's Merge now or Close PR (issue #677, after-done.ts) on a finished job's open pull request. Answered at once
// (issue #1194, design.md "Actions answer at once"): the checks the hopper can make itself — the job, its source running
// and following pull requests, the job following an open one —, then the answer. The act is a row of the source's GitHub
// outbox (issue #1238 part 3), so a restart does not lose it, and the source sends it at once, with no batch window. Sent,
// on the job's report chain, the source merges the pull request or closes it without a merge, and that is recorded as a
// follow is, with who pressed it. A refusal for now waits the outbox's backoff; one GitHub refuses for good, or the last
// attempt, records `job.pull_request_act_failed` with why. The same job's act sent again while its row is on its way (a
// second click, another tab, the CLI) answers that one.
import type { OutboxActs } from '../domain/github-outbox.ts';
import type { JobSource, PullRequestActAnswer, UserStore } from '../domain/ports.ts';
import { SourceError } from '../domain/ports.ts';
import { following, type ActingPerson, type FollowUp, type Job, type PullRequestAct } from '../domain/types.ts';

export interface PullRequestActsContext {
  store: Pick<UserStore, 'jobs' | 'events'>;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(job: Job): JobSource | undefined;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Keep what the source answered, and record the merge or the close, by `acting`. */
  record(jobId: string, r: FollowUp, acting: ActingPerson): void;
  /** The source's outbox sends now: its act must be seen at once. */
  sendNow(source: JobSource): void;
}


export function createPullRequestActs(c: PullRequestActsContext) {
  const { store } = c;
  const noPullRequest = (jobId: string) => `job ${jobId} has no open pull request`;

  /** The act's row sent: the source follows the pull request with the act, on the job's report chain, and it is recorded. Throws why it did not. */
  const send: OutboxActs['pullRequest'] = async ({ act: what, jobId, acting }) => {
    let error: unknown;
    await c.enqueue(jobId, async () => {
      try {
        const job = store.jobs.get(jobId);
        const source = job && c.sourceOf(job);
        if (!job || !following(job)) throw new SourceError(noPullRequest(jobId), true);
        if (!source?.follow) throw new SourceError(`job ${jobId}: its source is not running, or follows no pull request`, false);
        const r = await source.follow(job, what);
        if (!r) throw new SourceError(noPullRequest(jobId), true);
        c.record(jobId, r, acting);
      } catch (e) {
        error = e;
      }
    });
    if (error !== undefined) throw error;
  };

  /** The act's row failed for good: said once, with why. */
  const gaveUp: OutboxActs['gaveUp'] = ({ act: what, jobId, acting }, error) => {
    store.events.append({ type: 'job.pull_request_act_failed', jobId, data: { act: what, error: `${what === 'merge' ? 'merge' : 'close'} refused: ${error}`, ...acting } });
  };

  function act(jobId: string, what: PullRequestAct, person: ActingPerson): PullRequestActAnswer {
    const job = store.jobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found', message: `job ${jobId} not found` };
    const source = c.sourceOf(job);
    if (!source?.follow || !source.pullRequestAct) return { ok: false, reason: 'conflict', message: `job ${jobId}: its source is not running, or follows no pull request` };
    if (!following(job)) return { ok: false, reason: 'conflict', message: noPullRequest(jobId) };
    const under = source.pullRequestAct(job, what, person);
    if (!under) return { ok: false, reason: 'conflict', message: `job ${jobId}: its source is not connected` };
    c.sendNow(source);
    return { ok: true, jobId, act: under };
  }

  return { act, acts: { pullRequest: send, gaveUp } satisfies OutboxActs };
}
