// The wait check (issue #1694, design.md "Wait checks"): what the hopper tests of a job's own wait, with no model, and when.
// Kept with the wait (`JobWait.check`), so a hopper after a restart, or another hopper, goes on from it. The events that
// settle a wait stay the fast path (wait-on.ts, watched-items.ts); the check is the backstop when one is missed. A sweeper
// (engine/wait-checks.ts) takes each check due under a lease, tests its condition, and ends the wait when it is met; else it
// tries again later, the time between doubling. Past its deadline the wait is overdue once, and a person is told. Pure.
import type { Job, JobWait } from './types.ts';
import { waitOnLabel } from './wait-on.ts';
import { watchedOf, watchKey, type WatchedRef } from './watched-items.ts';

/** What a wait check tests. `none`: nothing the hopper can test; only its deadline counts. */
export type WaitCondition =
  | { kind: 'items_ended'; refs: WatchedRef[] }
  | { kind: 'job_ended'; jobId: string }
  | { kind: 'question_settled'; questionId: string }
  | { kind: 'command_exited' }
  | { kind: 'none' };

/** A job's wait check: its condition, its next check, the time between checks, its deadline, and what the last check found. */
export interface WaitCheck {
  condition: WaitCondition;
  nextCheckAt: string;
  everyMs: number;
  attempts: number;
  deadline: string;
  checkedAt?: string;
  /** What the last check found, in a few words. */
  result?: string;
  /** When it passed its deadline: once, and a person was told. */
  overdueAt?: string;
  /** The hopper woke the job for this condition at its wait before: met again, it is no wake but overdue. */
  repeat?: true;
}

/** What a check found: met, with what the job is told; or not met, with why. */
export type CheckOutcome = { met: true; note: string; told?: string } | { met: false; result: string };

export const FIRST_CHECK_MS = 60_000;
export const MAX_EVERY_MS = 30 * 60_000;
/** A wait on its own command is checked at least this often: its nudge's grace is minutes. */
export const COMMAND_MAX_EVERY_MS = 5 * 60_000;
export const DEADLINE_MS = 24 * 3600_000;
export const COMMAND_DEADLINE_MS = 4 * 3600_000;
export const OVERDUE_EVERY_MS = 3600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** What the hopper can test of `job`'s wait. */
export function conditionOf(job: Pick<Job, 'id' | 'status' | 'wait' | 'source'>): WaitCondition {
  const on = job.wait?.on;
  if (job.wait?.ownCommand || on?.kind === 'own_command') return { kind: 'command_exited' };
  if (on?.kind === 'job') return { kind: 'job_ended', jobId: on.jobId };
  if (on?.kind === 'question') return { kind: 'question_settled', questionId: on.questionId };
  if (on?.kind === 'pull_request') {
    const repo = on.repo ?? job.source?.repo;
    return repo ? { kind: 'items_ended', refs: [{ kind: 'issue', repo, number: on.number }] } : { kind: 'none' };
  }
  const refs = watchedOf(job);
  return refs.length > 0 ? { kind: 'items_ended', refs } : { kind: 'none' };
}

/** The condition as a key: the same condition, the same key. */
export function conditionKey(c: WaitCondition): string {
  switch (c.kind) {
    case 'items_ended': return `items_ended:${c.refs.map(watchKey).sort().join(' ')}`;
    case 'job_ended': return `job_ended:${c.jobId}`;
    case 'question_settled': return `question_settled:${c.questionId}`;
    default: return c.kind;
  }
}

/** An item as a person reads it. */
export const refLabel = (r: WatchedRef): string => (r.kind === 'issue' ? `${r.repo}#${r.number}` : `${r.repo} run ${r.runId}`);

/** The check of a new wait: a minute after it began; a wait flagged stuck before (issue #1037) at once. `wokenFor`: the condition the hopper last woke the job for. */
export function newCheck(job: Pick<Job, 'id' | 'status' | 'wait' | 'source'>, nowMs: number, wokenFor?: string): WaitCheck {
  const w = job.wait!;
  const condition = conditionOf(job);
  const since = Date.parse(w.since);
  const next = w.stuckAt ? nowMs : since + FIRST_CHECK_MS;
  const deadline = since + (condition.kind === 'command_exited' ? COMMAND_DEADLINE_MS : DEADLINE_MS);
  const repeat = condition.kind === 'items_ended' && wokenFor === conditionKey(condition);
  return { condition, nextCheckAt: iso(next), everyMs: FIRST_CHECK_MS, attempts: 0, deadline: iso(deadline), ...(repeat ? { repeat: true as const } : {}) };
}

/** The check after one not met at `nowMs`: tried again later, the time between doubling. `overdue`: it passed its deadline now. */
export function afterCheck(check: WaitCheck, result: string, nowMs: number, overdueNow = false): { check: WaitCheck; overdue: boolean } {
  const past = overdueNow || nowMs >= Date.parse(check.deadline);
  const overdue = past && !check.overdueAt;
  const cap = check.condition.kind === 'command_exited' ? COMMAND_MAX_EVERY_MS : MAX_EVERY_MS;
  const wait = past ? OVERDUE_EVERY_MS : Math.min(check.everyMs, cap);
  const everyMs = past ? OVERDUE_EVERY_MS : Math.min(check.everyMs * 2, cap);
  const next: WaitCheck = {
    ...check, attempts: check.attempts + 1, checkedAt: iso(nowMs), result, nextCheckAt: iso(nowMs + wait), everyMs,
    ...(overdue ? { overdueAt: iso(nowMs) } : {}),
  };
  return { check: next, overdue };
}

/** What the job is told when its check ends its wait. */
export const checkEndedNote = (w: Pick<JobWait, 'for' | 'on'> | undefined, note: string): string =>
  `[hopper] The hopper ended your wait (${w?.on ? waitOnLabel(w.on) : w?.for ?? 'what you waited on'}): ${note}. Check it, then go on with the job.`;

/** What a job on its own command is told when the hopper ends that wait. */
const commandNote = (why: string): string =>
  `[hopper] The hopper ended your wait on your own command: ${why}. Read the command's output. If it still runs and you still wait on it, end your turn with HOPPER_WAITING again. Else go on with the job.`;

/** What the executor said of the pane: its background work runs, and its pane is lost; null when it cannot tell. */
export interface CommandSeen { runs: boolean | null; lost: boolean | null }

/**
 * A wait on its own command (issue #1037): met when its pane is lost, when its command is gone and the grace after its
 * nudge passed (or it was flagged stuck before), or when it lasted past its deadline. Never left stuck for a person.
 */
export function commandOutcome(w: Pick<JobWait, 'since' | 'nudgedAt' | 'stuckAt'>, seen: CommandSeen, nowMs: number, graceMs: number): CheckOutcome {
  if (seen.lost === true) return met('its pane was lost');
  if (seen.runs === null) return { met: false, result: 'the hopper cannot read its pane now' };
  const hours = Math.round(COMMAND_DEADLINE_MS / 3600_000);
  if (nowMs - Date.parse(w.since) >= COMMAND_DEADLINE_MS) return met(`you waited ${hours} hours on it`);
  if (seen.runs) return { met: false, result: 'its command runs' };
  if (w.stuckAt) return met('its command is gone, and you did not go on');
  if (w.nudgedAt && nowMs - Date.parse(w.nudgedAt) >= graceMs) return met('its command is gone, and you did not go on after a nudge');
  return { met: false, result: 'its pane shows no background work' };
}

function met(why: string): CheckOutcome {
  return { met: true, note: why, told: commandNote(why) };
}

/** The leases on wait checks (issue #1694): one hopper tests a job's wait check at a time; a lease ends by itself at `until`. */
export interface WaitCheckLeases {
  /** True when `owner` now holds the job's lease: it was free, ended before `now`, its own, or for an older wait. */
  claim(jobId: string, since: string, owner: string, until: string, now: string): boolean;
  holds(jobId: string, owner: string, now: string): boolean;
  release(jobId: string, owner: string): void;
}
