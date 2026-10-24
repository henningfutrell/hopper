// Companion pull requests (issue #1143 reopened, design.md "Companion pull requests"), the sync loop's half: in a round of
// every follow, after the census, the companions of each item whose newest job holds them (`companionsOf`) are read by the
// source (`JobSource.readCompanions`) and kept on that job (`companions` in its source state). The tends ask `due`: the
// first companion with merge conflicts is rebased as a followed pull request is, through the tending queue — the base
// merge first, else a rebase tend job of the item (`tended.companion`). `view` is the job as if it followed the companion,
// for the base merge, the queue's conflict check and the base tip. Not while the source is paused; a throw is logged and
// asked again at the next round.
import { openedPullRequests } from '../domain/direct-jobs.ts';
import { asFollowing, companionDue, companionsAfter, companionsOf, type CompanionSeen } from '../domain/companion-pull-requests.ts';
import type { JobSource } from '../domain/ports.ts';
import { pullRequestRepo, type Job } from '../domain/types.ts';
import type { AfterDoneContext } from './after-done.ts';

/** How many of a job's `github_proxy.done` events are read for the pull requests it opened. */
const OPENED_READ = 1000;
/** The work-item states after which an item's companions are read no more. */
const OVER: readonly string[] = ['done', 'dropped'];

type Companions = Record<string, CompanionSeen>;
const companionsOfJob = (j: Job | undefined): Companions | undefined => (j?.sourceState?.source as { companions?: Companions } | undefined)?.companions;

export function companionPullRequests(c: Pick<AfterDoneContext, 'store' | 'enqueue' | 'finalReported' | 'setSource'>) {
  const { store } = c;
  const get = (id: string) => store.jobs.get(id);
  const opened = (jobId: string) => openedPullRequests(store.events.recent(OPENED_READ, ['github_proxy.done'], jobId));
  const open = (key: string) => { const i = store.workItems.get(key); return !OVER.includes(i?.state ?? '') && i?.issueState !== 'closed'; };

  /** Read the companions of the source's jobs `listed`, and keep what each read saw on the job that holds them. */
  async function read(source: JobSource, listed: Job[]): Promise<void> {
    if (!source.readCompanions || source.paused?.() !== undefined) return;
    const held = companionsOf(listed.map((j) => get(j.id) ?? j), opened, get, open).filter((h) => c.finalReported(h.holder));
    if (held.length === 0) return;
    try {
      const pulls = held.flatMap((h) => h.companions.map((url) => ({ repo: pullRequestRepo(url, h.holder.source!.repo!), number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) })));
      const answers = await source.readCompanions(pulls);
      await Promise.all(held.map((h) => c.enqueue(h.holder.id, async () => {
        const job = get(h.holder.id);
        if (!job) return;
        const after = companionsAfter(job, h.companions, answers);
        if (JSON.stringify(after) !== JSON.stringify(companionsOfJob(job) ?? {})) c.setSource(job.id, { ...(job.sourceState?.source ?? {}), companions: after });
      })));
    } catch (e) {
      console.warn(`hopper: ${source.name}: reading the companion pull requests failed, asked again at the next round: ${(e as Error).message}`);
    }
  }

  /** The companion rebase due for `job`, the newest job of its item; undefined: none. No read for a job with no companions (issue #1154). */
  function due(job: Job): { step: 'rebase'; url: string; checks: { failed: []; rerun: false }; companion: true } | undefined {
    if (!companionsOfJob(job) || !job.source || store.jobs.getBySourceKey(job.source.key)?.id !== job.id) return undefined;
    const d = companionDue(job, get);
    return d && { step: 'rebase', url: d.url, checks: { failed: [], rerun: false }, companion: true };
  }

  /** After the base merge pushed to companion `url` of the job: no merge conflicts till the next read. False: no companion. */
  function baseMerged(jobId: string, url: string): boolean {
    const job = get(jobId);
    const was = companionsOfJob(job)?.[url];
    if (!job || !was) return false;
    c.setSource(jobId, { ...(job.sourceState?.source ?? {}), companions: { ...companionsOfJob(job), [url]: { ...was, conflicting: false } } });
    return true;
  }

  return { read, due, baseMerged, view: (job: Job, url: string | undefined): Job => (url ? asFollowing(job, url) : job) };
}
