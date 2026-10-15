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
// A job on a wait for its own background command (issue #1037) that has not gone on is watched too (`ownCommandRuns`): its
// pane shows no background work for the grace, it is nudged once (`job.own_command_nudged`); the grace after that, still
// not gone on, its wait is flagged stuck (`job.own_command_stuck`) and it waits on a person.
// Then the runner reattaches it: the executor watches the new turn until the next outcome.
// The job already runs physically, so it never waits for a lane: with none idle it opens one
// more, marked past the cap (`pastCap`), over the lane cap until it ends: the decider drains that lane first (issue #1181).
import type { PaneAnswer } from '../domain/ports.ts';
import type { Job, JobWait } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';

/** Stored as the answer when the typed text cannot be read back from the pane. */
export const ANSWERED_IN_PANE = '(answered in the pane)';
export const REATTACH_REASON = 'answered in the pane';
/** Nobody answered (issue #376): the agent denied its dialog by itself when the countdown ran out. */
export const LAPSED_REASON = 'the dialog lapsed';
/** A job on its own wait (issue #483) went on by itself in its pane: its background check woke it, or a person typed to it there. */
export const WAIT_ENDED_REASON = 'the wait ended in the pane';

/** What a job waiting on its own command is told once when its pane shows no background work and it did not go on (issue #1037). */
export const ownCommandNudge = (w: Pick<JobWait, 'until'>): string =>
  `[hopper] You wait on your own background command (until: ${w.until ?? 'it ends'}), but your screen shows no background work and you did not go on. Check the command: read its output, or start it again. Then go on with the job.`;

export interface PaneAnswers {
  /** Probe every waiting job once; overlapping calls are skipped. */
  sweep(): Promise<void>;
}

export function createPaneAnswers(c: EngineContext, reattach: (claim: Claim) => void): PaneAnswers {
  const { store } = c;
  let busy = false;

  /** In the tx: an idle lane on the job's machine, else a new one, marked past the cap (issue #1181). */
  function laneFor(job: Job): string {
    const machineId = job.resumeOn ?? job.spec.machineId ?? 'local';
    const idle = store.lanes.list().find((l) => l.machineId === machineId && l.state === 'idle');
    if (idle) return idle.id;
    const lane = store.lanes.update(store.lanes.open(machineId).id, { pastCap: true });
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

  /** In the tx: the job's wait takes `patch`, while it is still the same wait. */
  function patchWait(job: Job, patch: Partial<JobWait>): boolean {
    const now = store.jobs.get(job.id);
    if (now?.status !== 'waiting_on' || !now.wait || now.wait.since !== job.wait?.since) return false;
    store.jobs.update(job.id, { wait: { ...now.wait, ...patch } });
    return true;
  }

  /** A job waiting on its own command that has not gone on (issue #1037): its command gone for the grace, a nudge; the grace after it, stuck. */
  async function watchOwnCommand(job: Job): Promise<void> {
    const w = job.wait;
    const executor = c.executors.get(job.spec.executor);
    if (!w?.ownCommand || w.stuckAt || !executor?.ownCommandRuns) return;
    const runs = await executor.ownCommandRuns(job).catch(() => null);
    if (runs === null || c.stopping()) return;
    const at = nowIso(c);
    const passed = (since: string): boolean => c.clock.now().getTime() - Date.parse(since) >= c.ownCommandGraceMs;
    if (runs) {
      if (w.goneSince) store.tx(() => patchWait(job, { goneSince: undefined }));
      return;
    }
    if (!w.goneSince) {
      store.tx(() => patchWait(job, { goneSince: at }));
      return;
    }
    if (!w.nudgedAt) {
      if (!passed(w.goneSince)) return;
      const delivered = executor.nudgeInPane ? await executor.nudgeInPane(job, ownCommandNudge(w)).catch(() => false) : false;
      store.tx(() => {
        if (patchWait(job, { nudgedAt: at })) store.events.append({ type: 'job.own_command_nudged', jobId: job.id, data: { delivered } });
      });
      return;
    }
    if (!passed(w.nudgedAt) || !passed(w.goneSince)) return;
    store.tx(() => {
      if (patchWait(job, { stuckAt: at })) store.events.append({ type: 'job.own_command_stuck', jobId: job.id, data: {} });
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
          if (c.stopping()) continue;
          if (!seen) {
            if (job.status === 'waiting_on') await watchOwnCommand(job);
            continue;
          }
          const claim = job.status === 'waiting_on' ? adoptWait(job.id, seen) : adopt(job.id, job.questionId!, seen);
          if (claim) reattach(claim);
        }
      } finally {
        busy = false;
      }
    },
  };
}
