// Asking on the issue thread (issue #435, design.md "The hopper label means full automation"), the sync loop's half: at
// each sync of a source with a thread, and when a question reaches a person or is approved, on the job's report chain.
// A job on a question (`waiting_answer`, or parked) whose question is open at the human stage and not kept for the owner
// (`keptBy`) gets the policy for its repository: `post` puts the question on its issue as one comment
// (`question.thread_posted`); `review` holds it (`question.thread_held`) until a person approves it
// (`question.thread_approved`), then posts it; `off` leaves it to the hopper alone. Once posted, the first reply by the
// connected account or a maintainer settles the question (`SourceHost.answerFromThread`), which resumes the job. The
// engine parks the job as soon as its question has a thread record (src/engine/auto-park.ts). A throw is kept as the
// job's retry and asked again next sync.
// The replies are read on the GitHub watch of the job's issue (issue #427): a `github_watch.changed` of the job with new
// comments starts its pass at once. A sync reads them only when the watch cannot tell (`threadUnseen`).
import type { JobSource, SourceHost, UserStore } from '../domain/ports.ts';
import type { DomainEvent } from '../domain/types.ts';
import {
  DEFAULT_THREAD_ASK, threadUnseen, threadAnswer, threadAnsweredBy, threadPolicy, threadReply, type Job, type Question, type ThreadAsk,
} from '../domain/types.ts';

export interface ThreadAsksContext {
  store: Pick<UserStore, 'jobs' | 'questions' | 'events' | 'settings' | 'tx' | 'githubWatches'>;
  host: Pick<SourceHost, 'answerFromThread'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  now(): string;
  /** Asking the source failed: kept as the job's retry. */
  failed(jobId: string, e: unknown): void;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(jobId: string): JobSource | undefined;
}

/** The events that start a job's pass at once: its question reached a person, a person approved it for the thread, or the watch of its issue saw a new comment. */
const starts = (e: DomainEvent): boolean => e.type === 'question.escalated_to_human' || e.type === 'question.thread_approved'
  || (e.type === 'github_watch.changed' && ((e.data.changes as { comments?: { added?: unknown[] } } | undefined)?.comments?.added?.length ?? 0) > 0);

/** What started a pass: a sync reads the thread only when the watch cannot tell; an event always reads it. */
type Start = 'sync' | 'event';

const ON_A_QUESTION = new Set(['waiting_answer', 'parked']);

/** The open question at the human stage a job waits on, unless the owner keeps it; else undefined. */
function askable(store: ThreadAsksContext['store'], job: Job): Question | undefined {
  if (!ON_A_QUESTION.has(job.status) || !job.questionId || !job.source?.repo || job.source.number === undefined) return undefined;
  const q = store.questions.get(job.questionId);
  return q?.status === 'open' && q.tier === 'human' && !q.keptBy ? q : undefined;
}

export function createThreadAsks(c: ThreadAsksContext) {
  const { store } = c;

  /** Keep the question's thread record and its event in one tx, on a question still open. */
  const record = (q: Question, thread: ThreadAsk, type: 'question.thread_held' | 'question.thread_posted', data: Record<string, unknown>) => store.tx(() => {
    if (store.questions.get(q.id)?.status !== 'open') return;
    store.questions.update(q.id, { thread });
    store.events.append({ type, jobId: q.jobId, questionId: q.id, data: { questionId: q.id, ...data } });
  });

  async function post(source: JobSource, job: Job, q: Question, approvedBy?: string): Promise<void> {
    const { repo, number } = job.source as { repo: string; number: number };
    const { commentId, url } = await source.thread!.ask(repo, number, q.id, q.text);
    record(q, { state: 'posted', at: c.now(), commentId, url, ...(approvedBy ? { approvedBy } : {}) }, 'question.thread_posted', { url, ...(approvedBy ? { approvedBy } : {}) });
  }

  async function tend(source: JobSource, jobId: string, by: Start): Promise<void> {
    const job = store.jobs.get(jobId);
    const q = job && askable(store, job);
    if (!job || !q) return;
    const { repo, number } = job.source as { repo: string; number: number };
    const account = job.source?.assignee;
    const ask = q.thread;
    if (!ask) {
      const policy = threadPolicy(store.settings.getThreadAsk() ?? DEFAULT_THREAD_ASK, repo, account);
      if (policy === 'post') await post(source, job, q);
      else if (policy === 'review') record(q, { state: 'review', at: c.now() }, 'question.thread_held', { repo, number });
      return;
    }
    if (ask.state === 'approved') return post(source, job, q, ask.approvedBy);
    if (ask.state !== 'posted' || (by === 'sync' && !threadUnseen(ask, store.githubWatches.get(jobId)))) return;
    const reply = threadReply(await source.thread!.comments(repo, number), ask, account);
    if (reply) c.host.answerFromThread(q.id, threadAnswer(reply, account), threadAnsweredBy(reply));
  }

  /** One job's pass, on its report chain. */
  const one = (source: JobSource, jobId: string, by: Start): Promise<void> => c.enqueue(jobId, async () => {
    try {
      await tend(source, jobId, by);
    } catch (e) {
      c.failed(jobId, e);
    }
  });

  return {
    /** A question reached a person, was approved, or the watch saw a comment: its job's pass now. True when the event was one; listeners fire inside append, so never a source call from there. */
    follows(e: DomainEvent): boolean {
      if (!starts(e) || !e.jobId) return false;
      const { jobId } = e;
      setImmediate(() => { const source = c.sourceOf(jobId); if (source?.thread) void one(source, jobId, 'event'); });
      return true;
    },
    /** Every job of the source on a question it can ask on its thread. */
    async catchUp(source: JobSource, jobs: Job[]): Promise<void> {
      if (!source.thread) return;
      await Promise.all(jobs.filter((j) => askable(store, j)).map((j) => one(source, j.id, 'sync')));
    },
  };
}
