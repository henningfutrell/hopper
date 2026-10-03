// Recording an executor's outcome: one transaction that ends the job (finished / failed /
// cancelled) or parks it on a question (waiting_answer), and frees its lane either way.
// design.md "Questions" lifecycle and "Question budget (B6)".
import type { ExecutionOutcome, ExecutionQuestion } from '../domain/ports.ts';
import type { Job, Lane, LaneId } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';

/** What the caller must do after the commit: clean up a terminal job, or start the answer chain. */
export type Recorded = { kind: 'terminal' } | { kind: 'question'; questionId: string };

const TERMINAL: Recorded = { kind: 'terminal' };

function fail(c: EngineContext, job: Job, laneId: LaneId | undefined, error: string, at: string): Recorded {
  c.store.jobs.update(job.id, { status: 'failed', error, finishedAt: at, pendingAnswer: undefined });
  c.store.events.append({ type: 'job.failed', jobId: job.id, ...(laneId ? { laneId } : {}), data: { error } });
  return TERMINAL;
}

function ask(c: EngineContext, job: Job, lane: Lane | undefined, laneId: LaneId, question: ExecutionQuestion, at: string): Recorded {
  const { store } = c;
  if (store.questions.list({ jobId: job.id }).length >= c.maxQuestions) return fail(c, job, laneId, 'too many questions', at);
  const q = store.questions.create({
    jobId: job.id, text: question.text, recentOutput: question.recentOutput, detectedBy: question.detectedBy,
  });
  store.jobs.update(job.id, {
    status: 'waiting_answer', questionId: q.id, laneId: undefined, pendingAnswer: undefined,
    resumeOn: lane?.machineId ?? job.resumeOn ?? job.spec.machineId,
  });
  store.events.append({
    type: 'question.asked', jobId: job.id, laneId, questionId: q.id,
    data: { questionId: q.id, text: q.text, detectedBy: q.detectedBy },
  });
  return { kind: 'question', questionId: q.id };
}

function releaseLane(c: EngineContext, lane: Lane | undefined, at: string): void {
  if (!lane) return;
  if (lane.state === 'draining') {
    c.store.lanes.close(lane.id);
    c.store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'drained' } });
  } else {
    c.store.lanes.update(lane.id, { state: 'idle', jobId: undefined, idleSince: at });
  }
}

/** The pending answer (if any) is cleared here, in the tx recording the resume's outcome (B2). */
/** `cancelReason` set: the job was cancelled while running; the outcome is discarded. */
export function recordOutcome(c: EngineContext, job: Job, laneId: LaneId, outcome: ExecutionOutcome, cancelReason: string | undefined): Recorded {
  const { store } = c;
  return store.tx(() => {
    const at = nowIso(c);
    const lane = store.lanes.list().find((l) => l.id === laneId);
    let recorded: Recorded = TERMINAL;
    if (cancelReason !== undefined) {
      store.jobs.update(job.id, { status: 'cancelled', finishedAt: at, pendingAnswer: undefined });
      store.events.append({ type: 'job.cancelled', jobId: job.id, laneId, data: { reason: cancelReason } });
    } else if (outcome.kind === 'finished') {
      store.jobs.update(job.id, { status: 'finished', result: outcome.result, finishedAt: at, pendingAnswer: undefined });
      store.events.append({ type: 'job.finished', jobId: job.id, laneId, data: { result: outcome.result } });
    } else if (outcome.kind === 'failed') {
      fail(c, job, laneId, outcome.error, at);
    } else {
      recorded = ask(c, job, lane, laneId, outcome.question, at);
    }
    releaseLane(c, lane, at);
    return recorded;
  });
}
