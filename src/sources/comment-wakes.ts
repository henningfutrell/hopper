// A comment ends the job's own wait (issue #2159, design.md "A comment ends the job's own wait"), the sync loop's half. The
// GitHub watch of a job on its own wait (its issue, its own pull request) records `github_watch.changed` with the comments
// it saw added, by id, author and time, never their text. On that event the job's pass reads the item's comments through
// its source's thread, and the first one since the wait began by a trusted account, not one a job posted, ends the wait
// (`SourceHost.wakeOnComment`): the job is told the comment as untrusted text. A comment by anyone else wakes nothing.
// A throw is kept as the job's retry; the comment is not read again, and the job's wait checks still run.
import { commentWakeNote, wakingComment } from '../domain/comment-wake.ts';
import type { WatchChanges } from '../domain/github-watch.ts';
import type { JobSource, SourceHost, UserStore } from '../domain/ports.ts';
import type { DomainEvent } from '../domain/types.ts';

export interface CommentWakesContext {
  store: Pick<UserStore, 'jobs' | 'events'>;
  host: Pick<SourceHost, 'wakeOnComment'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Reading the comments failed: kept as the job's retry. */
  failed(jobId: string, e: unknown): void;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(jobId: string): JobSource | undefined;
}

/** The links of the comments jobs posted through the GitHub proxy since `since`: a job's own comment wakes no job. */
function postedSince(store: CommentWakesContext['store'], since: string): Set<string> {
  return new Set(store.events.between(['github_proxy.done'], since).filter((e) => e.data.op === 'issue.comment' && typeof e.data.url === 'string').map((e) => e.data.url as string));
}

export function createCommentWakes(c: CommentWakesContext) {
  const { store } = c;

  async function pass(source: JobSource, jobId: string, e: DomainEvent): Promise<void> {
    const job = store.jobs.get(jobId);
    const wait = job?.status === 'waiting_on' ? job.wait : undefined;
    const added = (e.data.changes as WatchChanges | undefined)?.comments?.added ?? [];
    const repo = e.data.repo, number = (e.data.pointer as { number?: unknown } | undefined)?.number;
    if (!job || !wait || !added.length || typeof repo !== 'string' || typeof number !== 'number' || !source.thread) return;
    if (!added.some((x) => Date.parse(x.at) >= Date.parse(wait.since))) return;
    const comment = wakingComment(await source.thread.comments(repo, number), added, wait.since, job.source?.assignee, postedSince(store, wait.since));
    if (comment) c.host.wakeOnComment(jobId, wait.since, { url: comment.url, author: comment.author }, commentWakeNote(wait, comment));
  }

  return {
    /** The watch of a job on its own wait saw new comments: its pass now. Listeners fire inside append, so never a source call from there. */
    follows(e: DomainEvent): void {
      if (e.type !== 'github_watch.changed' || !e.jobId) return;
      const { jobId } = e;
      if (store.jobs.get(jobId)?.status !== 'waiting_on') return;
      setImmediate(() => {
        const source = c.sourceOf(jobId);
        if (!source?.thread) return;
        void c.enqueue(jobId, async () => {
          try {
            await pass(source, jobId, e);
          } catch (err) {
            c.failed(jobId, err);
          }
        });
      });
    },
  };
}
