// A job on a question answered outside the hopper (design.md "Questions" → "Answered in the pane").
// The owner may type the answer straight into a waiting job's pane. On every tick the engine asks
// each waiting job's executor (`answeredInPane`) whether its work runs again; when it does, one
// tx: the question is answered by the human with the typed text (the answer chain aborts), the
// job is `running` on a lane of its machine, `job.reattached { reason: "answered in the pane" }`.
// A dialog nobody answered before its countdown ran out (issue #376) is no answer: the agent denied it by
// itself. The question is `lapsed` (`question.lapsed`), nobody answered it, and the job is reattached the
// same way, `reason: "the dialog lapsed"`.
// A job on its own wait (issue #483) is probed the same way: its agent going on by itself (its own background check
// woke it) ends the wait, and it is reattached, `reason: "the wait ended in the pane"`.
// Then the runner reattaches it: the executor watches the new turn until the next outcome.
// The job already runs physically, so it never waits for a lane: with none idle it opens one
// more, over the lane cap until it ends (the decider drains the extra lane).
import type { PaneAnswer } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';

/** Stored as the answer when the typed text cannot be read back from the pane. */
export const ANSWERED_IN_PANE = '(answered in the pane)';
export const REATTACH_REASON = 'answered in the pane';
/** Nobody answered (issue #376): the agent denied its dialog by itself when the countdown ran out. */
export const LAPSED_REASON = 'the dialog lapsed';
/** A job on its own wait (issue #483) went on by itself in its pane: its background check woke it, or a person typed to it there. */
export const WAIT_ENDED_REASON = 'the wait ended in the pane';

export interface PaneAnswers {
  /** Probe every waiting job once; overlapping calls are skipped. */
  sweep(): Promise<void>;
}

export function createPaneAnswers(c: EngineContext, reattach: (claim: Claim) => void): PaneAnswers {
  const { store } = c;
  let busy = false;

  /** In the tx: an idle lane on the job's machine, else a new one (over the cap). */
  function laneFor(job: Job): string {
    const machineId = job.resumeOn ?? job.spec.machineId ?? 'local';
    const idle = store.lanes.list().find((l) => l.machineId === machineId && l.state === 'idle');
    if (idle) return idle.id;
    const lane = store.lanes.open(machineId);
    store.events.append({ type: 'lane.opened', laneId: lane.id, machineId, data: {} });
    return lane.id;
  }

  /** In the tx: the job runs again on a lane of its machine, its executor state the one its pane showed. */
  function onLane(job: Job, seen: PaneAnswer, reason: string, questionId?: string): Claim {
    const laneId = laneFor(job);
    store.lanes.update(laneId, { state: 'busy', jobId: job.id, idleSince: undefined });
    store.jobs.update(job.id, {
      status: 'running', laneId, executorState: seen.executorState, pendingAnswer: undefined, holdReason: undefined, waitReason: undefined, wait: undefined,
      startedAt: job.startedAt ?? nowIso(c),
    });
    store.events.append({ type: 'job.reattached', jobId: job.id, laneId, ...(questionId ? { questionId } : {}), data: { reason } });
    return { jobId: job.id, laneId };
  }

  function adopt(jobId: string, questionId: string, seen: PaneAnswer): Claim | undefined {
    return store.tx(() => {
      const job = store.jobs.get(jobId);
      if (job?.status !== 'waiting_answer' || job.questionId !== questionId) return undefined;
      const settled = seen.lapsed ? c.questions.lapsedInPane(questionId) : c.questions.answeredInPane(questionId, seen.answer ?? ANSWERED_IN_PANE);
      if (!settled) return undefined;
      return onLane(job, seen, seen.lapsed ? LAPSED_REASON : REATTACH_REASON, questionId);
    });
  }

  /** A job on its own wait (issue #483) whose agent went on by itself, or was typed to in its pane: the wait ended there. */
  function adoptWait(jobId: string, seen: PaneAnswer): Claim | undefined {
    return store.tx(() => {
      const job = store.jobs.get(jobId);
      return job?.status === 'waiting_on' ? onLane(job, seen, WAIT_ENDED_REASON) : undefined;
    });
  }

  return {
    async sweep() {
      if (busy || c.stopping()) return;
      busy = true;
      try {
        for (const job of store.jobs.list({ status: ['waiting_answer', 'waiting_on'] })) {
          const probe = c.executors.get(job.spec.executor)?.answeredInPane;
          if (!probe || (job.status === 'waiting_answer' && !job.questionId)) continue;
          const seen = await probe(job).catch(() => null);
          if (!seen || c.stopping()) continue;
          const claim = job.status === 'waiting_on' ? adoptWait(job.id, seen) : adopt(job.id, job.questionId!, seen);
          if (claim) reattach(claim);
        }
      } finally {
        busy = false;
      }
    },
  };
}
