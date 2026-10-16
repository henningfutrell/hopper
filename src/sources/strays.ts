// Stray pull requests (issue #1143 part 4, design.md "Pull request housekeeping"), the sync loop's half: in a round of every
// follow, after reconciling, the pull requests jobs named that no job follows, of items no job works on
// (`strayPullRequests`), each held by the newest job that names it once that job's end is reported, are given to the
// source (`JobSource.housekeepStrays`). Each one it moved to the landing branch, or closed as superseded, is recorded on the
// job that holds it, marked `stray`; a closed one is that job's follow's end (`follow: closed`), so it is no stray from now
// on. One the source found ended on GitHub (issue #1420: merged, or closed without a merge, by someone else) is recorded
// the same way, `job.pull_request_merged` or `job.pull_request_closed` with `stray`, and that job's `follow` is how it ended:
// before, a stray closed on GitHub was left as it was, and the job that holds it showed it open for ever. A stray is never
// tended: a person, a cancel or a failed tend left it, and that stands. Not while the source is paused; a throw is logged
// and asked again at the next round.
import type { JobSource } from '../domain/ports.ts';
import { strayPullRequests, type Job, type StrayHousekept } from '../domain/types.ts';
import type { AfterDoneContext } from './after-done.ts';

export function strayHousekeeping(c: Pick<AfterDoneContext, 'store' | 'enqueue' | 'finalReported' | 'setSource'>) {
  const { store } = c;

  function kept(d: StrayHousekept): void {
    if ('retargeted' in d) {
      store.events.append({ type: 'job.pull_request_retargeted', jobId: d.jobId, data: { pullRequest: d.pullRequest, ...d.retargeted, stray: true } });
      return;
    }
    const follow = 'ended' in d ? d.ended : 'closed';
    c.setSource(d.jobId, { ...(store.jobs.get(d.jobId)?.sourceState?.source ?? {}), pullRequest: d.pullRequest, follow });
    store.events.append({
      type: follow === 'merged' ? 'job.pull_request_merged' : 'job.pull_request_closed', jobId: d.jobId,
      data: { pullRequest: d.pullRequest, part: d.part, ...('superseded' in d ? { superseded: d.superseded } : {}), stray: true },
    });
  }

  /** Housekeeping of the strays among `listed`, the source's jobs. */
  return async function strays(source: JobSource, listed: Job[]): Promise<void> {
    if (!source.housekeepStrays || source.paused?.() !== undefined) return;
    const found = strayPullRequests(listed.map((j) => store.jobs.get(j.id) ?? j)).flatMap((f) => {
      const job = store.jobs.get(f.jobId);
      return job && c.finalReported(job) ? [{ job, pullRequest: f.pullRequest, part: f.part }] : [];
    });
    if (found.length === 0) return;
    try {
      const done = await source.housekeepStrays(found);
      await Promise.all(done.map((d) => c.enqueue(d.jobId, async () => { kept(d); })));
    } catch (e) {
      console.warn(`hopper: ${source.name}: housekeeping of stray pull requests failed, asked again at the next round: ${(e as Error).message}`);
    }
  };
}
