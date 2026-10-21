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
// not gone on, its wait check ends the wait (issue #1694, wait-checks.ts): it is never left stuck for a person.
// A job on a wait only its pane can end (issue #1508, `paneCarriesWait`: its own command; issue #2338: no outside event) whose pane is lost — its machine or herdr restarted — is woken by the hopper, told so
// (`job.wait_ended { by: hopper }`): its resume opens a new pane. Asked on every tick, so after a start and a seat's restart too.
// Then the runner reattaches it: the executor watches the new turn until the next outcome.
// Any other wait whose pane is lost (issue #1779: its agent session ended, its pane a bare shell) is marked stranded
// (`strandedAt`), never ended: what it waits on, or a person (stuck work, `stranded`), wakes it, and its resume opens a new pane.
// A wait whose agent the hopper ended to free memory (issue #2303, `waitReleased`) is not probed: it has no pane.
// The job already runs physically, so it never waits for a lane: with none idle it opens one
// more, marked past the cap (`pastCap`), over the lane cap until it ends: the decider drains that lane first (issue #1181).
import type { PaneAnswer } from '../domain/ports.ts';
import type { Job, JobWait } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import type { Claim } from './decision-step.ts';
import { paneCarriesWait } from '../domain/watched-items.ts';
import { waitOnLabel } from '../domain/wait-on.ts';
import { recordEndWait } from './wait.ts';

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

/** What a job whose wait its lost pane carried is told when the hopper ends that wait (issue #1508). */
export const paneLostNote = (w: Pick<JobWait, 'for' | 'on'> | undefined): string =>
  `[hopper] The hopper ended your wait (${w?.on ? waitOnLabel(w.on) : w?.for ?? 'what you waited on'}): your pane was lost, so the background command that was to end the wait stopped. Check what you waited for. If you still wait, start the poll again, then end your turn with HOPPER_WAITING.`;

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
      // Another hopper adopts it now (issue #1662): it holds the job's lease.
      if (job?.status !== 'waiting_answer' || job.questionId !== questionId || !c.leases.take(jobId)) return undefined;
      const settled = seen.lapsed ? c.questions.lapsedInPane(questionId) : c.questions.answeredInPane(questionId, seen.answer ?? ANSWERED_IN_PANE);
      if (!settled) return undefined;
      return onLane(job, seen, seen.lapsed ? LAPSED_REASON : REATTACH_REASON, questionId);
    });
  }

  /** A job on its own wait (issue #483) whose agent went on by itself, or was typed to in its pane: the wait ended there. */
  function adoptWait(jobId: string, seen: PaneAnswer): Claim | undefined {
    return store.tx(() => {
      const job = store.jobs.get(jobId);
      return job?.status === 'waiting_on' && c.leases.take(jobId) ? onLane(job, seen, WAIT_ENDED_REASON) : undefined;
    });
  }

  /** In the tx: the job's wait takes `patch`, while it is still the same wait. */
  function patchWait(job: Job, patch: Partial<JobWait>): boolean {
    const now = store.jobs.get(job.id);
    if (now?.status !== 'waiting_on' || !now.wait || now.wait.since !== job.wait?.since) return false;
    store.jobs.update(job.id, { wait: { ...now.wait, ...patch } });
    return true;
  }

  /** A job waiting on its own command that has not gone on (issue #1037): its command gone for the grace, a nudge. Its wait check ends the wait after (issue #1694). */
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
    if (w.nudgedAt || !passed(w.goneSince)) return;
    const delivered = executor.nudgeInPane ? await executor.nudgeInPane(job, ownCommandNudge(w)).catch(() => false) : false;
    store.tx(() => {
      if (patchWait(job, { nudgedAt: at })) store.events.append({ type: 'job.own_command_nudged', jobId: job.id, data: { delivered } });
    });
  }

  /**
   * A wait its lost pane carried (issue #1508): the hopper ends it. True when it did. Any other wait whose pane is lost is
   * marked stranded (issue #1779), and unmarked when its agent is seen again: what it waits on still wakes it.
   */
  async function wakeLost(job: Job): Promise<boolean> {
    const probe = c.executors.get(job.spec.executor)?.paneLost;
    const lost = probe ? await probe(job).catch(() => null) : null;
    if (lost === null || c.stopping()) return false;
    if (!paneCarriesWait(job)) {
      if (lost !== Boolean(job.wait?.strandedAt)) store.tx(() => patchWait(job, { strandedAt: lost ? nowIso(c) : undefined }));
      return false;
    }
    if (!lost) return false;
    const ended = store.tx(() => {
      const now = store.jobs.get(job.id);
      if (now?.status !== 'waiting_on' || now.wait?.since !== job.wait?.since) return false;
      recordEndWait(c, job.id, 'its pane was lost', 'hopper', paneLostNote);
      return true;
    });
    if (ended) c.trigger('job.wait_ended');
    return ended;
  }

  return {
    async sweep() {
      if (busy || c.stopping()) return;
      busy = true;
      try {
        for (const job of store.jobs.list({ status: ['waiting_answer', 'waiting_on'] })) {
          const probe = c.executors.get(job.spec.executor)?.answeredInPane;
          // Its agent ended to free memory (issue #2303): no pane of its own to probe, and its old pane id may name another's.
          if (!probe || (job.status === 'waiting_answer' && !job.questionId) || job.waitReleased) continue;
          const seen = await probe(job).catch(() => null);
          if (c.stopping()) continue;
          if (!seen) {
            if (job.status === 'waiting_on' && !(await wakeLost(job))) await watchOwnCommand(job);
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
