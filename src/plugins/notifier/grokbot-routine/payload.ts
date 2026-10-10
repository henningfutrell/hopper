// The Grok Bot routine's JSON bodies (design.md "Grok Bot routine webhook"). A question's body carries
// what the job already knows (issue #378), so the receiver can route and rank it without calling back
// into the hopper: the machine (its id and name) and lane that raised it (issue #485: the question's own
// snapshot, not where its job is now), the priority and whether it is high priority (issue #535), the issue's labels, repo and number, what
// detected the question, and how long it has been open.
import type { DomainEvent, Job, Question } from '../../sdk.ts';

const base = (kind: string, at: string, job: Job | undefined, jobId: string | undefined) => ({
  source: 'hopper', kind, at, jobId: jobId ?? null, issueTitle: job?.source?.title ?? null, issueUrl: job?.source?.url ?? null,
});

export interface QuestionBody {
  question: Question;
  job: Job | undefined;
  answerUrl: string | undefined;
  at: string;
  now: Date;
  /** True: sent from the open questions (when the routine became configured, or Send open questions), not as it escalated. */
  offered: boolean;
  /** The high-priority threshold (issue #535); absent: not known, and `high` is null. */
  highPriority?: number | undefined;
}

/** A question that reached the human. */
export function questionPayload(b: QuestionBody): Record<string, unknown> {
  const { question: q, job } = b;
  const raised = q.raisedBy;
  return {
    ...base('question.escalated_to_human', b.at, job, q.jobId),
    question: q.text, questionId: q.id, ...(b.answerUrl ? { answerUrl: b.answerUrl } : {}),
    machineId: raised?.machineId ?? null, machineName: raised?.name ?? null, laneId: raised?.laneId ?? null, priority: job?.priority ?? null,
    high: job && b.highPriority !== undefined ? job.priority >= b.highPriority : null,
    labels: job?.source?.labels ?? null, repo: job?.source?.repo ?? null, issueNumber: job?.source?.number ?? null,
    detectedBy: q.detectedBy, askedAt: q.createdAt, escalatedAt: q.escalatedToHumanAt ?? null,
    openSeconds: Math.max(0, Math.floor((b.now.getTime() - Date.parse(q.createdAt)) / 1000)),
    offered: b.offered,
    // Issue #376: a dialog the agent denies by itself at this time, unless it is answered first.
    ...(q.lapsesAt ? { lapsesAt: q.lapsesAt } : {}),
  };
}

/** A stop of intake (issue #358). `source` is the sender (the hopper): the job source's name goes as `sourceName`. */
export function intakePayload(e: DomainEvent, job: Job | undefined): Record<string, unknown> {
  const b = base(e.type, e.at, job, e.jobId);
  if (e.type === 'source.stalled') return { ...b, sourceName: e.data.source, error: e.data.error, since: e.data.since };
  if (e.type === 'connected_account.expired') return { ...b, provider: e.data.provider, account: e.data.account, reason: e.data.reason };
  return b;
}

/**
 * Send test event (issue #378): marked `test: true`, so a receiver can tell it from a question. Its kind is a
 * question's (issue #481), so the receiver's routing takes the same path as for a real one.
 */
export function testPayload(at: string): Record<string, unknown> {
  return { source: 'hopper', kind: 'question.escalated_to_human', test: true, at, message: 'Test event from the hopper: the routine URL and key work.' };
}
