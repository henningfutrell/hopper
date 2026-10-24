// The assessor's judgement of one failed job (issue #509, design.md "Failure assessment"), rules first. Pure: the
// service gathers the evidence and acts on the result. In order: the open problem of its signature takes it; a
// known shared cause opens a problem; a signature on enough items of one machine or executor flags a general cause,
// unless its cause is job-specific (issue #625), which never joins an open problem either (issue #637); a transient cause runs
// again with backoff within the retry limit; anything else goes to a person. Two cases act on nothing (issue #517):
// a failure whose item already ran again is superseded, and one that failed more than a day before it was
// assessed keeps its decision but waits on a person — its work may be stale, and it is too old to hold others. A
// timed-out job (issue #630) is decided by its liveness first (`timed-out.ts`): its own, never grouped with others'. A
// failure it would hand to a person, of a job that reported a hopper bug about itself, is held on that report (issue #1147).
// A job whose own pull request's checks are red (issue #1230) goes on to fix them while under the retry limit, never grouped;
// so does one whose own pull request has merge conflicts or is a draft (issue #1265). The same failure as the run before it,
// on the same item, stops the item (issue #1461): a person, once, and nothing runs it again by itself. A failure it would run
// again or hand to a person, of a job whose command ran out of heap in several jobs, is held on that pattern (issue #2722).
import type { FailureClass, FailureDecision, FailureSettings, KnownCause, ProblemScope } from '../domain/types.ts';
import { HOPPER_BUG_CAUSE } from './hopper-bug.ts';
import { HEAP_ABORT_CAUSE } from './heap-pattern.ts';
import { DONE_CRITERIA_UNMET, OWN_PR_CHECKS_RED, OWN_PR_UNFINISHED } from './causes.ts';
import { judgeTimeout, type LivenessFacts, type TimeoutKind } from './timed-out.ts';

/** Another item's failure with the same signature, within the grouping window. */
export interface RecentFailure { jobId: string; machineId?: string; executor: string }

export interface AssessInput {
  error: string;
  signature: string;
  cause: KnownCause | undefined;
  job: { executor: string; machineId?: string; pinned: boolean };
  /** Its run in its chain of retries: 1 = the first. */
  attempt: number;
  ranMs?: number;
  tail?: string;
  /** Other items' failures with this signature within the grouping window, one per item. */
  recent: RecentFailure[];
  /** The open problem of this signature. */
  open?: { id: string; title: string; decision: 'hold' | 'redirect' };
  settings: FailureSettings;
  /** The newer job of its item, when one exists: it is superseded. */
  newer?: string | undefined;
  /** How long before this assessment it failed. */
  failedAgoMs?: number;
  /** A timed-out job's liveness (issue #630). */
  liveness?: LivenessFacts;
  /** The timed-out runs of its chain just before this one, newest first (issue #630). */
  earlierTimeouts?: TimeoutKind[];
  /**
   * The hopper bug the job reported about itself while it ran (issue #1147, `hopper-bug.ts`): its problem's title, why,
   * and the open problem of its report, if any.
   */
  hopperBug?: { title: string; reason: string; open?: string };
  /**
   * The heap abort pattern the job is part of (issue #2722, `heap-pattern.ts`): a command that ran out of heap in it and in
   * enough other jobs. Its problem's title, why, and the open problem of the command, if any.
   */
  heapPattern?: { title: string; reason: string; open?: string };
  /** A job whose own pull request's checks are red (issue #1230): how many times its chain was sent back for them already. */
  checksFixes?: number;
  /** A job whose own pull request has merge conflicts or is a draft (issue #1265): how many times its chain was sent back for it already. */
  unfinishedFixes?: number;
  /** A job whose done criteria are not met (issue #1924): how many times its chain was sent back for them already. */
  criteriaFixes?: number;
  /** The failure of its item's run before it has the same signature (issue #1461, `chain.ts` `repeatedOf`). */
  repeated?: boolean;
  /** Why its cause is not the one its text matches (issue #1522: its work shows its own pull request unfinished or red). */
  causeReason?: string;
}

/** A failure assessed longer than this after it failed takes no automatic action (issue #517). */
export const STALE_AFTER_MS = 86_400_000;

export type ProblemPlan =
  | { kind: 'join'; id: string }
  | { kind: 'open'; title: string; scope: ProblemScope; general: boolean; decision: 'hold' | 'redirect'; causeId?: string };

export interface Assessment {
  cls: FailureClass;
  decision: FailureDecision;
  reasons: string[];
  summary: string;
  /** False when the decision's automatic action is off: it waits for a person. */
  auto: boolean;
  /** A retry: its wait. */
  retryInMs?: number;
  problem?: ProblemPlan;
  /** The newer job of its item: nothing is left to do for this one. */
  superseded?: string;
  /** The same failure as its item's run before (issue #1461): stopped for a person, and Jev does not run it again. */
  repeated?: true;
}

/** The wait before retry `attempt` (1 = the first): the base, times the factor per earlier retry, at most the cap. */
export function backoffMs(attempt: number, s: FailureSettings): number {
  return Math.min(s.backoffMaxSec, s.backoffSec * s.backoffFactor ** Math.max(0, attempt - 1)) * 1000;
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h`;
  return `${Math.floor(ms / 86_400_000)} d`;
}

const headline = (text: string): string => (text.trim().split('\n', 1)[0] ?? '').slice(0, 200).replace(/\.+$/, '');
const lastLine = (text: string): string => text.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.slice(0, 200) ?? '';

/** Where a known cause's problem applies, from the job that hit it. */
function causeScope(cause: KnownCause, job: AssessInput['job']): ProblemScope {
  if (cause.scope === 'all' || job.machineId === undefined) return {};
  return cause.scope === 'executor' ? { machineId: job.machineId, executor: job.executor } : { machineId: job.machineId };
}

/** Where a general cause applies: the machine and executor every failure of it shares, if they share one. */
function sharedScope(all: RecentFailure[]): ProblemScope {
  const one = <T>(xs: (T | undefined)[]): T | undefined => (xs.every((x) => x !== undefined && x === xs[0]) ? xs[0] : undefined);
  const machineId = one(all.map((f) => f.machineId));
  const executor = one(all.map((f) => f.executor));
  return { ...(machineId !== undefined ? { machineId } : {}), ...(executor !== undefined ? { executor } : {}) };
}

/** Hold or redirect, for a job of a problem: redirected only when it may run elsewhere and redirect acts by itself. */
function placement(planned: 'hold' | 'redirect', i: AssessInput, scope: ProblemScope | undefined, reasons: string[]): 'hold' | 'redirect' {
  if (planned === 'hold') return 'hold';
  if (scope && scope.machineId === undefined) { reasons.push('held: the problem is on every machine'); return 'hold'; }
  if (i.job.machineId === undefined) { reasons.push('held: the job ran on no known machine'); return 'hold'; }
  if (i.job.pinned) { reasons.push(`held: the job is pinned to ${i.job.machineId}`); return 'hold'; }
  if (!i.settings.auto.redirect) { reasons.push('held: automatic redirect is off'); return 'hold'; }
  reasons.push(`redirected: the job may run on another machine than ${i.job.machineId}`);
  return 'redirect';
}

const RECOMMENDED: Record<FailureDecision, string> = { retry: 'Retry', hold: 'Hold', redirect: 'Redirect', person: 'A person', continue: 'Continue' };

function summaryOf(i: AssessInput, decision: FailureDecision, auto: boolean, title: string | undefined, retryInMs: number | undefined, lead?: string): string {
  lead ??= decision === 'retry' ? (auto ? `Runs again in ${duration(retryInMs ?? 0)}` : 'Retry recommended')
    : decision === 'continue' ? (auto ? (i.cause?.id === OWN_PR_CHECKS_RED ? 'Continues: it fixes the red checks of its pull request'
      : i.cause?.id === OWN_PR_UNFINISHED ? 'Continues: it finishes its pull request' : i.cause?.id === DONE_CRITERIA_UNMET ? 'Continues: it reworks its pull request to meet the done criteria' : 'Continues: it was at work') : 'Continue recommended')
    : decision === 'person' ? 'Needs a person'
      : !auto ? `Grouped: ${title}` : decision === 'redirect' ? `Redirected: ${title}` : `Held: ${title}`;
  const ran = `Ran ${i.attempt} ${i.attempt === 1 ? 'time' : 'times'}${i.job.machineId ? ` on ${i.job.machineId}` : ''}${i.ranMs !== undefined && i.attempt > 1 ? `, the last for ${duration(i.ranMs)}` : i.ranMs !== undefined && i.ranMs >= 1000 ? `, for ${duration(i.ranMs)}` : ''}`;
  const out = i.tail ? lastLine(i.tail) : '';
  return `${lead}. ${ran}. Failed: ${headline(i.error)}.${out ? ` Output: ${out}` : ''}`;
}

export function assess(i: AssessInput): Assessment {
  if (i.newer !== undefined) return superseded(i, i.newer);
  if (i.failedAgoMs !== undefined && i.failedAgoMs > STALE_AFTER_MS) return stale(i, i.failedAgoMs);
  const a = judge(i);
  if (i.hopperBug && a.decision === 'person' && i.settings.auto.hold) return heldOn(i, i.hopperBug, HOPPER_BUG_CAUSE, a);
  if (i.heapPattern && a.cls !== 'shared' && a.decision !== 'hold' && i.settings.auto.hold) return heldOn(i, i.heapPattern, HEAP_ABORT_CAUSE, a);
  return i.repeated && stopsOnRepeat(i.cause, a) ? stopped(i, a) : a;
}

/**
 * The causes a repeat does not stop (issue #1461): they say nothing of the item's work. A daemon restart cuts any job off;
 * a timeout has its own rule, from the job's liveness (`timed-out.ts`); a shared cause holds or redirects the job on its
 * problem, which its check or a person resolves.
 */
const REPEAT_KEEPS: readonly string[] = ['daemon-restart', 'timed-out'];

/** Whether a repeat stops this assessment: it would run the item again, or hand it to a person whom Jev may skip. */
function stopsOnRepeat(cause: KnownCause | undefined, a: Assessment): boolean {
  return a.cls !== 'shared' && !REPEAT_KEEPS.includes(cause?.id ?? '') && (a.decision === 'retry' || a.decision === 'continue' || a.decision === 'person');
}

/**
 * The same failure as its item's run before (issue #1461): a run again did not help, so a person looks at it, once. One the
 * rules give to a person already keeps its summary: the repeat only says so, and keeps Jev from running it again.
 */
function stopped(i: AssessInput, a: Assessment): Assessment {
  const reasons = [...a.reasons.filter((r) => !r.startsWith('automatic ') && !r.startsWith('transient: retry ')), `the same failure as the run before it (signature ${i.signature}): it stops here, for a person`];
  if (a.decision === 'person') return { ...a, reasons, repeated: true };
  return { cls: a.cls, decision: 'person', reasons, auto: true, repeated: true, summary: summaryOf(i, 'person', true, undefined, undefined, 'Stopped: the same failure twice in a row') };
}

/**
 * A failure the rules hand to a person, of a job that reported a hopper bug about itself (issue #1147): the hopper failed
 * it, so it waits on its report's problem — held, never a person's while it waits — and runs again once the fix landed.
 * A failure of a heap abort pattern (issue #2722) the same: a run again does not help, so it waits on the command's
 * problem, which a person resolves once the command is fixed or has more heap.
 */
function heldOn(i: AssessInput, on: { title: string; reason: string; open?: string }, causeId: string, a: Assessment): Assessment {
  return {
    cls: 'shared', decision: 'hold', reasons: [on.reason, ...a.reasons], auto: true, summary: summaryOf(i, 'hold', true, on.title, undefined),
    problem: on.open ? { kind: 'join', id: on.open } : { kind: 'open', title: on.title, scope: {}, general: false, decision: 'hold', causeId },
  };
}

/** What it would be without its age or a newer job: its class and decision. */
function judge(i: AssessInput): Assessment {
  const s = i.settings;
  const reasons: string[] = [i.cause ? `known cause: ${i.cause.name}` : 'no known cause matches', ...(i.causeReason ? [i.causeReason] : [])];
  const done = (cls: FailureClass, decision: FailureDecision, extra: { problem?: ProblemPlan; title?: string; retryInMs?: number } = {}): Assessment => {
    const auto = decision === 'person' || s.auto[decision];
    if (!auto) reasons.push(`automatic ${decision} is off: it waits for a person`);
    return {
      cls, decision, reasons, auto, summary: summaryOf(i, decision, auto, extra.title, extra.retryInMs),
      ...(extra.retryInMs !== undefined ? { retryInMs: extra.retryInMs } : {}), ...(extra.problem ? { problem: extra.problem } : {}),
    };
  };

  // Its own pull request's checks are red (issue #1230): its own work, never grouped; sent back while under the retry limit.
  if (i.cause?.id === OWN_PR_CHECKS_RED) {
    const fixes = i.checksFixes ?? 0;
    if (fixes < s.maxAttempts) {
      reasons.push(`its own pull request's checks are red: the failed checks run again once, then it goes on to fix them (${fixes + 1} of ${s.maxAttempts})`);
      return done('transient', 'continue');
    }
    reasons.push(`retry limit reached: sent back ${fixes} ${fixes === 1 ? 'time' : 'times'} for red checks`);
    return done('transient', 'person');
  }
  // Its own pull request has merge conflicts or is a draft (issue #1265): the same, sent back to finish it.
  if (i.cause?.id === OWN_PR_UNFINISHED) {
    const fixes = i.unfinishedFixes ?? 0;
    if (fixes < s.maxAttempts) {
      reasons.push(`its own pull request has merge conflicts or is a draft: it goes on to finish it (${fixes + 1} of ${s.maxAttempts})`);
      return done('transient', 'continue');
    }
    reasons.push(`retry limit reached: sent back ${fixes} ${fixes === 1 ? 'time' : 'times'} to finish its pull request`);
    return done('transient', 'person');
  }
  // Its done criteria are not met (issue #1924): the same, sent back to rework; at the limit it fails, with the reason, for a person.
  if (i.cause?.id === DONE_CRITERIA_UNMET) {
    const fixes = i.criteriaFixes ?? 0;
    if (fixes < s.maxAttempts) {
      reasons.push(`a done criterion of its skills is not met: it goes on to rework its pull request (${fixes + 1} of ${s.maxAttempts})`);
      return done('transient', 'continue');
    }
    reasons.push(`retry limit reached: sent back ${fixes} ${fixes === 1 ? 'time' : 'times'} for its done criteria`);
    return done('transient', 'person');
  }
  if (i.cause?.id === 'timed-out') {
    const t = judgeTimeout(i.liveness ?? {}, i.earlierTimeouts ?? [], s);
    reasons.push(...t.reasons);
    return t.decision === 'retry' ? done('transient', 'retry', { retryInMs: backoffMs(1, s) }) : done('transient', t.decision);
  }
  // A job-specific cause is its own job's: it never joins a problem, even one of its signature (issue #637).
  if (i.open && i.cause?.cls !== 'job') {
    reasons.push(`same signature as the open problem: ${i.open.title}`);
    return done('shared', placement(i.open.decision, i, undefined, reasons), { problem: { kind: 'join', id: i.open.id }, title: i.open.title });
  }
  if (i.cause?.cls === 'shared') {
    const scope = causeScope(i.cause, i.job);
    const planned = i.cause.decision === 'redirect' ? 'redirect' : 'hold';
    const title = `${i.cause.name}${scope.machineId ? ` on ${scope.machineId}` : ''}`;
    const decision = placement(planned, i, scope, reasons);
    return done('shared', decision, { problem: { kind: 'open', title, scope, general: false, decision: planned, causeId: i.cause.id }, title });
  }
  const items = i.recent.length + 1;
  const scope = sharedScope([...i.recent, { jobId: '', executor: i.job.executor, ...(i.job.machineId !== undefined ? { machineId: i.job.machineId } : {}) }]);
  // A job-specific cause belongs to its one job, and a recurrence with no machine or executor in common has no
  // shared place to hold: neither is a general cause (issue #625).
  if (items >= s.groupThreshold && i.cause?.cls !== 'job' && (scope.machineId !== undefined || scope.executor !== undefined)) {
    reasons.push(`${items} jobs failed with this signature within ${s.groupWindowMin} min: flagged as a general cause`);
    const title = `Recurring: ${headline(i.error).slice(0, 80)}`;
    return done('shared', 'hold', { problem: { kind: 'open', title, scope, general: true, decision: 'hold', ...(i.cause ? { causeId: i.cause.id } : {}) }, title });
  }
  if (i.cause?.cls === 'transient') {
    if (i.attempt - 1 < s.maxAttempts) {
      const retryInMs = backoffMs(i.attempt, s);
      reasons.push(`transient: retry ${i.attempt} of ${s.maxAttempts} in ${duration(retryInMs)}`);
      return done('transient', 'retry', { retryInMs });
    }
    reasons.push(`retry limit reached: ${s.maxAttempts} ${s.maxAttempts === 1 ? 'retry' : 'retries'}`);
    return done('transient', 'person');
  }
  if (!i.cause) reasons.push('not seen on other jobs: it needs a person');
  return done(i.cause?.cls ?? 'job', 'person');
}

/** Its item already ran again: what it would have been, kept for the profile, with no action and no problem. */
function superseded(i: AssessInput, newer: string): Assessment {
  const { problem: _p, retryInMs: _r, ...a } = judge({ ...i, open: undefined, recent: [] });
  return {
    ...a, superseded: newer, reasons: [...a.reasons, `a newer job of its item exists: ${newer}: nothing is left to do`],
    summary: summaryOf(i, a.decision, a.auto, undefined, undefined, `Already run again (job ${newer})`),
  };
}

/** Failed long before it was assessed: its decision, as recommended, waits on a person; it groups nothing. */
function stale(i: AssessInput, failedAgoMs: number): Assessment {
  const a = judge({ ...i, open: undefined, recent: [] });
  const decision = a.problem?.kind === 'open' ? a.problem.decision : a.decision;
  const reasons = [...a.reasons.filter((r) => !r.startsWith('automatic ') && !r.startsWith('held: ') && !r.startsWith('redirected: ')),
    `failed ${duration(failedAgoMs)} before it was assessed: too old to act on by itself, it waits on a person`];
  const lead = decision === 'person' ? 'Needs a person' : `${RECOMMENDED[decision]} recommended${i.cause && decision !== 'retry' ? `: ${i.cause.name}` : ''}`;
  return { cls: a.cls, decision, reasons, auto: decision === 'person', summary: summaryOf(i, decision, false, undefined, undefined, lead) };
}
