// Asking on the issue thread (issue #435, design.md "The hopper label means full automation"), the sync loop's half: at
// each sync of a source with a thread, and when a question reaches a person or is approved, on the job's report chain.
// A job on a question (`waiting_answer`, or parked) whose question is open at the human stage and not kept for the owner
// (`keptBy`) gets the policy for its repository: `post` puts the question on its issue as one comment
// (`question.thread_posted`); `review` holds it (`question.thread_held`) until a person approves it
// (`question.thread_approved`), then posts it; `off` leaves it to the hopper alone. Once posted, the first reply by the
// connected account or a maintainer settles the question (`SourceHost.answerFromThread`), which resumes the job. The
// engine parks the job as soon as its question has a thread record (src/engine/auto-park.ts). A throw is kept as the
// job's retry and asked again next sync.
import type { JobSource, SourceHost, UserStore } from '../domain/ports.ts';
import type { DomainEvent } from '../domain/types.ts';
import {
  DEFAULT_THREAD_ASK, threadAnswer, threadAnsweredBy, threadPolicy, threadReply, type Job, type Question, type ThreadAsk,
} from '../domain/types.ts';

export interface ThreadAsksContext {
  store: Pick<UserStore, 'jobs' | 'questions' | 'events' | 'settings' | 'tx'>;
  host: Pick<SourceHost, 'answerFromThread'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  now(): string;
  /** Asking the source failed: kept as the job's retry. */
  failed(jobId: string, e: unknown): void;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(jobId: string): JobSource | undefined;
}

/** The events that start a job's pass at once: its question reached a person, or a person approved it for the thread. */
const STARTS = new Set(['question.escalated_to_human', 'question.thread_approved']);

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

  async function tend(source: JobSource, jobId: string): Promise<void> {
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
    if (ask.state !== 'posted') return;
    const reply = threadReply(await source.thread!.comments(repo, number), ask, account);
    if (reply) c.host.answerFromThread(q.id, threadAnswer(reply, account), threadAnsweredBy(reply));
  }

  /** One job's pass, on its report chain. */
  const one = (source: JobSource, jobId: string): Promise<void> => c.enqueue(jobId, async () => {
    try {
      await tend(source, jobId);
    } catch (e) {
      c.failed(jobId, e);
    }
  });

  return {
    /** A question reached a person, or was approved: its job's pass now. True when the event was one; listeners fire inside append, so never a source call from there. */
    follows(e: DomainEvent): boolean {
      if (!STARTS.has(e.type) || !e.jobId) return false;
      const { jobId } = e;
      setImmediate(() => { const source = c.sourceOf(jobId); if (source?.thread) void one(source, jobId); });
      return true;
    },
    /** Every job of the source on a question it can ask on its thread. */
    async catchUp(source: JobSource, jobs: Job[]): Promise<void> {
      if (!source.thread) return;
      await Promise.all(jobs.filter((j) => askable(store, j)).map((j) => one(source, j.id)));
    },
  };
}
