// What the UI session routes (and the sync loop, through the SourceHost) ask of the engine.
// Each command validates, writes in one transaction, emits its event, and lets the event
// listener schedule the next Decision. Jobs are created only by ingest (source-host.ts).
import { TERMINAL_STATUSES } from '../domain/types.ts';
import type { DismissedBy } from '../domain/locked.ts';
import type { ActingPerson, Job, JobNote, UsageReading } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { cleanupDue, type Cleanups } from './cleanup.ts';
import { parkRefusal, recordPark, recordUnpark, releaseParked } from './park.ts';
import { openItemOf } from './reviews.ts';
import { parkAskOf, type ParkAsk } from '../domain/park-ask.ts';
import type { Runner } from './runner.ts';
import { recordEndWait, recordPollSeen, type WaitEnder } from './wait.ts';
import type { WaitOn } from '../domain/wait-on.ts';
import { recordNote } from './notes.ts';
import { acceptNewText, keepOriginal } from './item-snapshots.ts';
import { recordApproveTrust, recordDeny, recordLiftQuarantine, recordQuarantine } from './quarantine.ts';
import { recordCriticalFlag } from './critical-flag.ts';

const isTerminal = (job: Job): boolean => TERMINAL_STATUSES.includes(job.status);

function existing(c: EngineContext, id: string): Job {
  const job = c.store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  if (isTerminal(job)) throw new EngineError('conflict', `job ${id} is already ${job.status}`);
  return job;
}

export interface Commands {
  /**
   * Cancel a non-terminal job; `reason` is recorded on job.cancelled (and told to its source). `note` (issue #1460): a
   * person's own words why, kept on job.cancelled beside the reason; never told to the source.
   */
  cancel(id: string, reason: string, note?: string): Job;
  /** A job on its own wait whose item closed by its own work (issue #1460): it ends finished, `result` its result. 409 for any other. */
  finishWaiting(id: string, result: string): Job;
  approve(id: string): Job;
  /**
   * Claim a waiting job as operator-led (issue #318): an operator does its work by hand, outside the
   * hopper. It holds no lane and the decider never runs it; its source finishes it once its work is complete.
   */
  claimByOperator(id: string): Job;
  /**
   * Take a locked entry out of the queue (issue #355): the failed job stays failed, and can still run again. `by`: a
   * person (default), or nothing waits on it any more (issue #1123).
   */
  dismiss(id: string, by?: DismissedBy): Job;
  /**
   * Park a running job, or one on a question (issue #501): its lane frees, its pane and agent end, its work tree,
   * agent session, machine and open question are kept. A running job is parked once its executor stepped aside.
   * `ask` (issue #2167): who parked it and why, kept on it.
   */
  park(id: string, ask?: ParkAsk): Job;
  /**
   * Re-queue a parked job (issue #501): pinned to its machine, its claim resumes its agent session; with its question open, it waits on it again.
   * A job with no agent session only with `freshSession` (issue #530): its claim starts a fresh one in its kept work tree.
   * `elsewhere` (issue #921): not pinned to its machine; its claim rebuilds its work from its checkpoint where it runs.
   */
  requeue(id: string, o?: { freshSession?: boolean; elsewhere?: boolean; who?: ParkAsk }): Job;
  /**
   * End a job's own wait (issue #483), a person's act, or the hopper's with an answer the job asked it for (issue #998): it
   * is queued again, pinned to its machine, and told in its pane that what it waited for has happened, with `note`.
   * Conflict unless it is `waiting_on`.
   */
  endWait(id: string, note?: string, by?: WaitEnder): Job;
  /**
   * The GitHub proxy saw the job poll `on` (issue #1210), and answered `answer`: a job on a wait for its own command has its
   * wait typed as what it polls; an hour after the wait began, the hopper ends it with the answer. Nothing for another job.
   */
  pollSeen(id: string, on: WaitOn, answer: string): Job | undefined;
  /**
   * A person's note to a job (issue #997): queued on it until its session gets it — at the next turn boundary while it
   * runs, with its task or the answer it resumes with — or a new job of its item carries it. Conflict for an ended job.
   */
  addNote(id: string, text: string, acting: ActingPerson): JobNote;
  /** Issue #371: what a job's deferred cleanup could not reach was closed by hand; it is no longer tried, and its item's jobs may run. */
  markCleanedUp(id: string): Job;
  /** Rerun the original (issue #662): a job held for its changed item runs the snapshot's text. item.original_kept. */
  keepOriginalText(id: string, acting: ActingPerson): Job;
  /** Accept the new text (issue #662), the owner's act, allowed by Access first: the job runs it, and it is the item's snapshot. */
  acceptNewText(id: string, acting: ActingPerson): Job;
  /**
   * Quarantine (issue #655): a person sets a job that has not ended `quarantined` — held, and its proxy token opens no door
   * of the hopper —, or lifts it to the level the job had before. job.quarantined, job.unquarantined.
   */
  quarantine(id: string, acting: ActingPerson): Job;
  liftQuarantine(id: string, acting: ActingPerson): Job;
  /** The critical flag (issue #2203): a person marks a job critical, whatever its priority, or clears it. job.critical_flag_changed. */
  setCritical(id: string, critical: boolean, acting: ActingPerson): Job;
  /** Issue #655 part 4: a person approves the trust of a job Jev's trust check lowered: `approved`, never more. job.trust_approved. */
  approveTrust(id: string, acting: ActingPerson): Job;
  /** Issue #655 parts 5 and 13: a person, or Jev (`jev`), denied the job's request at gate 2: its trust one level lower, the second deny quarantines it. */
  denied(id: string, acting: ActingPerson | 'jev'): Job | undefined;
  /** Tests only: the fake usage source has no HTTP route. */
  setFakeUsage(reading: Omit<UsageReading, 'source' | 'at'>): UsageReading[];
}

export function createCommands(c: EngineContext, runner: Runner, cleanups: Cleanups): Commands {
  const { store } = c;
  const cleanup = cleanups.run;
  return {
    cancel(id, reason, note) {
      const job = existing(c, id);
      if (job.status === 'claimed' || job.status === 'running') {
        // The runner ends it `cancelled` once the executor has stopped: this hopper's, or the one that drives it (issue #1662).
        if (runner.cancel(id, reason, note) || c.leases.relay(id, { kind: 'cancel', reason, ...(note ? { note } : {}) })) return job;
      }
      // A waiting_answer or parked job's question is cancelled in the same tx; a job on a question or about to
      // resume holds a pane, and a parked job its work tree, released after the commit by the normal reap. No runner holds
      // it, so no lane is its: a lane id an earlier attempt left names a lane another job may hold now (issue #2676).
      const next = store.tx(() => {
        if ((job.status === 'waiting_answer' || job.status === 'parked') && job.questionId) c.questions.cancel(job.questionId);
        const cancelled = store.jobs.update(id, { status: 'cancelled', finishedAt: nowIso(c), laneId: undefined, pendingAnswer: undefined, ...cleanupDue(c) });
        store.events.append({ type: 'job.cancelled', jobId: id, data: { reason, ...(note ? { note } : {}) } });
        return cancelled;
      });
      void cleanup(id);
      return next;
    },

    finishWaiting(id, result) {
      // Its pane, kept on its machine for the wait, is released after the commit by the normal reap.
      const next = store.tx(() => {
        const job = existing(c, id);
        if (job.status !== 'waiting_on') throw new EngineError('conflict', `job ${id} is ${job.status}: only a job on its own wait ends finished when its item closes`);
        const finished = store.jobs.update(id, { status: 'finished', finishedAt: nowIso(c), result, wait: undefined, pendingAnswer: undefined, ...cleanupDue(c) });
        store.events.append({ type: 'job.finished', jobId: id, data: { result } });
        return finished;
      });
      void cleanup(id);
      return next;
    },

    approve(id) {
      existing(c, id);
      return store.tx(() => {
        const next = store.jobs.update(id, { approved: true });
        store.events.append({ type: 'job.approved', jobId: id, data: {} });
        return next;
      });
    },

    claimByOperator(id) {
      return store.tx(() => {
        const job = existing(c, id);
        if (job.status !== 'queued' && job.status !== 'held') throw new EngineError('conflict', `job ${id} is ${job.status}: only a waiting job can be claimed as operator-led`);
        const next = store.jobs.update(id, { status: 'operator_led', accepted: true, holdReason: undefined, waitReason: undefined, startedAt: nowIso(c) });
        store.events.append({ type: 'job.claimed_by_operator', jobId: id, data: {} });
        return next;
      });
    },

    dismiss(id, by = 'user') {
      return store.tx(() => {
        const job = store.jobs.get(id);
        if (!job) throw new EngineError('not_found', `job ${id} not found`);
        if (job.status !== 'failed' || job.dismissedAt !== undefined) throw new EngineError('conflict', `job ${id} is not a locked entry: only a failed job not yet dismissed can be dismissed`);
        const next = store.jobs.update(id, { dismissedAt: nowIso(c) });
        store.events.append({ type: 'job.dismissed', jobId: id, data: { by } });
        return next;
      });
    },

    park(id, ask) {
      const job = existing(c, id);
      const refused = parkRefusal(c, job);
      if (refused) throw new EngineError('conflict', refused);
      if (job.status === 'running') {
        // Who asked, kept on the job before its run is stopped: the run, here or on another hopper, records the park with it.
        const asked = store.tx(() => (existing(c, id).status === 'running' ? store.jobs.update(id, { parkAsk: parkAskOf(ask) }) : undefined));
        if (asked && (runner.park(id) || c.leases.relay(id, { kind: 'park' }))) return asked;
        if (asked) store.tx(() => store.jobs.update(id, { parkAsk: undefined }));
        throw new EngineError('conflict', `job ${id} is not running here yet: try again`);
      }
      const parked = store.tx(() => {
        // Read again in the tx: an answer may have re-queued it meanwhile.
        const now = existing(c, id);
        const late = parkRefusal(c, now);
        if (late) throw new EngineError('conflict', late);
        // Picked up with its question open (issue #692): its pane ended at its last park, and the executor is not asked.
        return { job: recordPark(c, now, 'waiting_answer', undefined, undefined, ask), paneless: now.parked !== undefined };
      });
      void releaseParked(c, parked.job, parked.paneless);
      return parked.job;
    },

    requeue(id, o = {}) {
      const next = store.tx(() => recordUnpark(c, id, o.freshSession === true, o.elsewhere === true, o.who));
      if (next.status === 'waiting_answer' && next.questionId) c.questions.unparked(next.questionId);
      // Its proposal or research report (issue #2167): a reviewer level the park stopped goes on.
      const item = next.status === 'waiting_answer' ? openItemOf(c, next) : undefined;
      if (item) c.reviews[item.kind].resume(item.id);
      return next;
    },

    endWait: (id, note, by) => store.tx(() => recordEndWait(c, id, note, by)),

    pollSeen: (id, on, answer) => store.tx(() => recordPollSeen(c, id, on, answer)),

    addNote: (id, text, acting) => store.tx(() => recordNote(c, id, text, acting)),

    markCleanedUp: (id) => cleanups.markCleanedUp(id),

    keepOriginalText: (id, acting) => store.tx(() => keepOriginal(c, id, acting)),
    acceptNewText: (id, acting) => store.tx(() => acceptNewText(c, id, acting)),
    quarantine: (id, acting) => store.tx(() => recordQuarantine(c, id, acting)),
    liftQuarantine: (id, acting) => store.tx(() => recordLiftQuarantine(c, id, acting)),
    setCritical: (id, critical, acting) => store.tx(() => recordCriticalFlag(c, id, critical, acting)),
    denied: (id, acting) => { const job = store.tx(() => recordDeny(c, id, acting)); if (job) c.trigger('job.trust_lowered'); return job; },
    approveTrust: (id, acting) => { const job = store.tx(() => recordApproveTrust(c, id, acting)); c.trigger('job.trust_approved'); return job; },

    setFakeUsage(reading) {
      if (!c.fakeUsage) throw new EngineError('not_found', 'no fake usage source is configured');
      const readings = c.fakeUsage.set(reading);
      c.trigger('usage.changed');
      return readings;
    },
  };
}
