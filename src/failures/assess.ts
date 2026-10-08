// The assessor's judgement of one failed job (issue #509, design.md "Failure assessment"), rules first. Pure: the
// service gathers the evidence and acts on the result. In order: the open problem of its signature takes it; a
// known shared cause opens a problem; a signature on enough items flags a general cause; a transient cause runs
// again with backoff within the retry limit; anything else goes to a person.
import type { FailureClass, FailureDecision, FailureSettings, KnownCause, ProblemScope } from '../domain/types.ts';

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
}

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
}

/** The wait before retry `attempt` (1 = the first): the base, times the factor per earlier retry, at most the cap. */
export function backoffMs(attempt: number, s: FailureSettings): number {
  return Math.min(s.backoffMaxSec, s.backoffSec * s.backoffFactor ** Math.max(0, attempt - 1)) * 1000;
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  return `${Math.floor(ms / 3_600_000)} h`;
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

function summaryOf(i: AssessInput, decision: FailureDecision, auto: boolean, title: string | undefined, retryInMs: number | undefined): string {
  const lead = decision === 'retry' ? (auto ? `Runs again in ${duration(retryInMs ?? 0)}` : 'Retry recommended')
    : decision === 'person' ? 'Needs a person'
      : !auto ? `Grouped: ${title}` : decision === 'redirect' ? `Redirected: ${title}` : `Held: ${title}`;
  const ran = `Ran ${i.attempt} ${i.attempt === 1 ? 'time' : 'times'}${i.job.machineId ? ` on ${i.job.machineId}` : ''}${i.ranMs !== undefined && i.attempt > 1 ? `, the last for ${duration(i.ranMs)}` : i.ranMs !== undefined && i.ranMs >= 1000 ? `, for ${duration(i.ranMs)}` : ''}`;
  const out = i.tail ? lastLine(i.tail) : '';
  return `${lead}. ${ran}. Failed: ${headline(i.error)}.${out ? ` Output: ${out}` : ''}`;
}

export function assess(i: AssessInput): Assessment {
  const s = i.settings;
  const reasons: string[] = [i.cause ? `known cause: ${i.cause.name}` : 'no known cause matches'];
  const done = (cls: FailureClass, decision: FailureDecision, extra: { problem?: ProblemPlan; title?: string; retryInMs?: number } = {}): Assessment => {
    const auto = decision === 'person' || s.auto[decision];
    if (!auto) reasons.push(`automatic ${decision} is off: it waits for a person`);
    return {
      cls, decision, reasons, auto, summary: summaryOf(i, decision, auto, extra.title, extra.retryInMs),
      ...(extra.retryInMs !== undefined ? { retryInMs: extra.retryInMs } : {}), ...(extra.problem ? { problem: extra.problem } : {}),
    };
  };

  if (i.open) {
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
  if (items >= s.groupThreshold) {
    reasons.push(`${items} jobs failed with this signature within ${s.groupWindowMin} min: flagged as a general cause`);
    const scope = sharedScope([...i.recent, { jobId: '', executor: i.job.executor, ...(i.job.machineId !== undefined ? { machineId: i.job.machineId } : {}) }]);
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
