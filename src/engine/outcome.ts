// Recording an executor's outcome: one transaction that ends the job (finished / failed /
// cancelled), pauses it on a question, a proposal or a research report (waiting_answer), or on its own wait (waiting_on,
// issue #483), and frees its lane either way.
// design.md "Questions" lifecycle and "Question budget (B6)".
import type { ExecutionOutcome, ExecutionQuestion } from '../domain/ports.ts';
import { raisedBy } from '../domain/raised-by.ts';
import { namesOwnCommand } from '../domain/own-command.ts';
import { suggestionIn } from '../domain/phase.ts';
import type { Job, JobLiveness, Lane, LaneId, MachineSnapshot, ReviewKind } from '../domain/types.ts';
import { planWaitEnd, settledAlready, waitOnLabel, waitOnOf, type WaitAsked, type WaitOn } from '../domain/wait-on.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';
import { nowIso, priorityTagOf, type EngineContext } from './context.ts';
import { cleanupDue } from './cleanup.ts';
import { recordReport } from './reviews.ts';
import { recordEndWait, wakeOn } from './wait.ts';
import { learnFromJob } from '../repo-memory/index.ts';

/** What the caller must do after the commit: clean up a terminal job, or start the answer chain. */
export type Recorded = { kind: 'terminal' } | { kind: 'question'; questionId: string } | { kind: 'report'; review: ReviewKind; itemId: string } | { kind: 'wait' };

const TERMINAL: Recorded = { kind: 'terminal' };

const TAIL_CHARS = 2000;

/** What a failure says when the sweep stopped the job's processes (issue #2707): read by `SWEPT` (src/failures/causes.ts). */
export const SWEPT_TEXT = 'the hopper\'s sweep stopped its processes';

/**
 * The failure text (issue #2707): an agent that exited after the sweep stopped the job's processes, with no failure of the
 * job since, exited by the hopper's act, so the text names the sweep and the job's status then.
 */
export function sweptError(c: Pick<EngineContext, 'store'>, job: Pick<Job, 'id'>, error: string): string {
  if (!/\bexited\b/.test(error)) return error;
  const last = c.store.events.recent(1, ['job.processes_stopped', 'job.failed'], job.id)[0];
  if (last?.type !== 'job.processes_stopped') return error;
  const d = last.data as { machineId: string; status: string };
  return `${SWEPT_TEXT} on ${d.machineId} while it was ${d.status}: ${error}`;
}

/** `liveness`: a timeout's (issue #630), kept on the job for the assessor. */
function fail(c: EngineContext, job: Job, laneId: LaneId | undefined, error: string, at: string, tail?: string, liveness?: JobLiveness): Recorded {
  const maskedError = maskGitHubTokens(sweptError(c, job, error));
  const maskedTail = tail ? maskGitHubTokens(tail.slice(-TAIL_CHARS)) : undefined;
  c.store.jobs.update(job.id, { status: 'failed', error: maskedError, finishedAt: at, pendingAnswer: undefined, liveness, ...cleanupDue(c), ...(maskedTail ? { errorTail: maskedTail } : {}) });
  c.store.events.append({ type: 'job.failed', jobId: job.id, ...(laneId ? { laneId } : {}), data: { error: maskedError, ...priorityTagOf(c, job.id) } });
  return TERMINAL;
}

function ask(c: EngineContext, job: Job, lane: Lane | undefined, laneId: LaneId, machine: MachineSnapshot | undefined, question: ExecutionQuestion, at: string): Recorded {
  const { store } = c;
  if (store.questions.list({ jobId: job.id }).length >= c.maxQuestions) return fail(c, job, laneId, 'too many questions', at);
  // Where it was asked (issue #485): a snapshot, so it stays right after the job moves or the machine changes.
  const raised = raisedBy({ laneId, resumeOn: job.resumeOn, pin: job.spec.machineId, machines: new Map(machine ? [[machine.id, machine.label]] : []) });
  // A phase shift the job suggests in its question (issue #548): offered to the person, never made by itself.
  const maskedText = maskGitHubTokens(question.text);
  const suggestion = suggestionIn(maskedText);
  const q = store.questions.create({
    jobId: job.id, text: maskedText, recentOutput: question.recentOutput ? maskGitHubTokens(question.recentOutput) : question.recentOutput, detectedBy: question.detectedBy, ...(suggestion ? { suggestion } : {}),
    tier: c.questions.firstStage(), ...(question.lapsesAt ? { lapsesAt: question.lapsesAt } : {}), ...(raised ? { raisedBy: raised } : {}),
  });
  store.jobs.update(job.id, {
    status: 'waiting_answer', questionId: q.id, laneId: undefined, pendingAnswer: undefined,
    resumeOn: lane?.machineId ?? job.resumeOn ?? job.spec.machineId,
  });
  store.events.append({
    type: 'question.asked', jobId: job.id, laneId, questionId: q.id, ...(raised ? { machineId: raised.machineId } : {}),
    data: { questionId: q.id, text: q.text, detectedBy: q.detectedBy, ...(raised ? { raisedBy: raised } : {}), ...priorityTagOf(c, job.id) },
  });
  return { kind: 'question', questionId: q.id };
}

/**
 * The job's own wait (issue #483): `waiting_on` what it named, no question, its lane freed, its pane kept on its machine. It
 * goes on when its agent goes on by itself (pane-answers.ts) or a person ends the wait (commands.ts `endWait`). A wait whose
 * `until:` names its own background command is marked `ownCommand` (issue #1037): it shows as running. `on` (issue #1245): what
 * it waits on, from its `on:` line or what it wrote. What it waits on happened already — its issue closed, its pull request
 * merged or closed, as the work-item ledger holds it (issue #1356) —: its wait ends at once, as that event would end it.
 * An infra plan's approval (issue #2205) ends at once too: approved already, or never to be approved by anyone (`planWaitEnd`).
 */
function wait(c: EngineContext, job: Job, lane: Lane | undefined, laneId: LaneId, w: WaitAsked, at: string): Recorded {
  const asked = { for: maskGitHubTokens(w.for), ...(w.until ? { until: maskGitHubTokens(w.until) } : {}), ...(w.on ? { on: maskGitHubTokens(w.on) } : {}) };
  // What it waits on (issue #1245), typed: never none.
  const masked = { for: asked.for, ...(asked.until ? { until: asked.until } : {}), on: waitOnOf(asked), ...(namesOwnCommand(w) ? { ownCommand: true as const } : {}) };
  // Its `check:` line (issue #1694): kept with the wait for its wait check; not on `job.waiting`.
  const checkLine = w.check ? maskGitHubTokens(w.check) : undefined;
  c.store.jobs.update(job.id, {
    status: 'waiting_on', wait: { ...masked, since: at, ...(checkLine ? { checkLine } : {}) }, laneId: undefined, pendingAnswer: undefined,
    // No question (issue #1780): one it asked before is answered or ended, so it keeps no questionId.
    resumeOn: lane?.machineId ?? job.resumeOn ?? job.spec.machineId, questionId: undefined,
  });
  c.store.events.append({ type: 'job.waiting', jobId: job.id, laneId, data: masked });
  // What it waits on happened already (issue #1356): no event comes for it now, so the hopper ends the wait at once.
  const settled = settledAlready(masked.on, job.source?.repo, c.store.workItems);
  if (settled && wakeOn(c, settled).length > 0) setImmediate(() => c.trigger('job.wait_ended'));
  else if (endPlanWait(c, job.id, masked.on)) setImmediate(() => c.trigger('job.wait_ended'));
  return { kind: 'wait' };
}

/** In the tx (issue #2205): a wait on an infra plan that is approved already, or that no person can approve, ends now. True when it ended. */
function endPlanWait(c: EngineContext, jobId: string, on: WaitOn): boolean {
  if (on.kind !== 'plan') return false;
  const plan = c.store.infraPlans.get(on.planId);
  const end = planWaitEnd(on.planId, plan, plan ? c.store.infraPlans.approval(plan.id) : undefined, c.clock.now(), plan ? c.store.infraPlans.rejection(plan.id) : undefined);
  if (!end) return false;
  if ('settled' in end) return wakeOn(c, end.settled).length > 0;
  recordEndWait(c, jobId, end.told, 'hopper', () => `[hopper] The hopper ended your wait (${waitOnLabel(on)}): ${end.told}.`);
  return true;
}

/** Frees a lane whose job no longer runs on it: a draining one closes, any other goes idle. */
export function releaseLane(c: EngineContext, lane: Lane | undefined, at: string): void {
  if (!lane) return;
  if (lane.state === 'draining') {
    c.store.lanes.close(lane.id);
    c.store.events.append({ type: 'lane.closed', laneId: lane.id, machineId: lane.machineId, data: { reason: 'drained' } });
  } else {
    c.store.lanes.update(lane.id, { state: 'idle', jobId: undefined, idleSince: at, pastCap: undefined });
  }
}

/** The pending answer (if any) is cleared here, in the tx recording the resume's outcome (B2). */
/**
 * `cancelled` set: the job was cancelled while running, for its reason and a person's note (issue #1460); the outcome is
 * discarded. `machine`: the lane's machine as it ran, for a question's raising machine.
 */
export function recordOutcome(c: EngineContext, job: Job, laneId: LaneId, outcome: ExecutionOutcome, cancelled: { reason: string; note?: string } | undefined, machine?: MachineSnapshot): Recorded {
  const { store } = c;
  return store.tx(() => {
    const at = nowIso(c);
    const lane = store.lanes.list().find((l) => l.id === laneId);
    // A parked, continued or released job's resumed run (issues #501, #551, #2303) has reopened its session: its next claim types into the pane again.
    if (job.parked || job.continued || job.waitReleased) store.jobs.update(job.id, { parked: undefined, continued: undefined, waitReleased: undefined });
    let recorded: Recorded = TERMINAL;
    if (cancelled !== undefined) {
      store.jobs.update(job.id, { status: 'cancelled', finishedAt: at, pendingAnswer: undefined, ...cleanupDue(c) });
      store.events.append({ type: 'job.cancelled', jobId: job.id, laneId, data: cancelled });
    } else if (outcome.kind === 'finished') {
      const part = outcome.partlyDone ? { partlyDone: outcome.partlyDone } : {};
      const maskedResult = typeof outcome.result === 'string' ? maskGitHubTokens(outcome.result) : outcome.result;
      store.jobs.update(job.id, { status: 'finished', result: maskedResult, finishedAt: at, pendingAnswer: undefined, ...part, ...cleanupDue(c) });
      store.events.append({ type: 'job.finished', jobId: job.id, laneId, data: { ...(maskedResult !== undefined && maskedResult !== null ? { result: maskedResult } : {}), ...part } });
      // The memory lines of its final message (issue #2847): what a later job of its repository is offered.
      learnFromJob(store, job, maskedResult, at, c.idGen);
    } else if (outcome.kind === 'failed') {
      fail(c, job, laneId, outcome.error, at, outcome.tail, outcome.liveness);
    } else if (outcome.kind === 'report') {
      const r = recordReport(c, job, lane, laneId, machine, outcome.review, outcome.report, at);
      recorded = { kind: 'report', review: r.kind, itemId: r.itemId };
    } else if (outcome.kind === 'wait') {
      recorded = wait(c, job, lane, laneId, outcome.wait, at);
    } else if (outcome.kind === 'paused') {
      // The run's end parks a job its agent paused at its budget (job-run.ts, issue #2848 part 3); one that comes here is not parked.
      fail(c, job, laneId, `paused at its budget, but not parked: ${outcome.why}`, at);
    } else {
      recorded = ask(c, job, lane, laneId, machine, outcome.question, at);
    }
    releaseLane(c, lane, at);
    return recorded;
  });
}
