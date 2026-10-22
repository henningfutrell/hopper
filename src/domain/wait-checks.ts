// The wait check (issue #1694, design.md "Wait checks"): what the hopper tests of a job's own wait, with no model, and when.
// Kept with the wait (`JobWait.check`), so a hopper after a restart, or another hopper, goes on from it. The events that
// settle a wait stay the fast path (wait-on.ts, watched-items.ts); the check is the backstop when one is missed. A sweeper
// (engine/wait-checks.ts) takes each check due under a lease, tests its condition, and ends the wait when it is met; else it
// tries again later, the time between doubling. Past its deadline the wait is overdue once, and a person is told. Part 2:
// the job names its next check-in, or a time to wake it at, on a `check:` line after HOPPER_WAITING (`checkAskOf`), and a
// wait on a pull request's checks is tested on its checks (`checksOutcome`). Part 3: a wait on a pull request's review is
// tested on its reviews (`reviewOutcome`). Issue #2335: a wait on an outside event the hopper watches nothing of — once a
// background poll in the job's pane — gets a recheck when the job named a check-in: at it, the hopper wakes the job to look
// again (`recheckOutcome`), so its agent can end while it waits. Issue #2338: with no check-in, nothing wakes it but a
// person (end-wait) or a time it named. Issue #2459: the recheck is at the check-in however long it is, not at 30 minutes. Pure.
import type { ChecksState } from './pull-requests.ts';
import type { Job, JobWait } from './types.ts';
import { waitOnLabel } from './wait-on.ts';
import { watchedOf, watchKey, type WatchedRef } from './watched-items.ts';

/** What a wait check tests. `none`: nothing the hopper can test; only its deadline counts. */
export type WaitCondition =
  | { kind: 'items_ended'; refs: WatchedRef[] }
  | { kind: 'job_ended'; jobId: string }
  | { kind: 'question_settled'; questionId: string }
  | { kind: 'command_exited' }
  // Part 2: the checks of a pull request ended (passed or failed), or it ended; the time a job named passed.
  | { kind: 'pr_checks_ended'; repo: string; number: number }
  | { kind: 'time_passed'; at: string }
  // Part 3: a pull request got a review after the wait began, or it ended.
  | { kind: 'pr_review_ended'; repo: string; number: number }
  // Issue #2335: an outside event the hopper watches nothing of; at `at`, the job is woken to look again.
  | { kind: 'recheck'; at: string }
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
  /** The time the job named on its `check:` line (part 2): at it, the wait ends, whatever its condition says. */
  wakeAt?: string;
}

/** What a job named on its `check:` line: its next check-in (`in 20m`, `every 5m`), or a time to wake it at (`after 2h`, `at <ISO time>`). */
export type CheckAsk = { inMs: number } | { at: string };

/** What a check found: met, with what the job is told; or not met, with why. */
export type CheckOutcome = { met: true; note: string; told?: string } | { met: false; result: string };

export const FIRST_CHECK_MS = 60_000;
export const MAX_EVERY_MS = 30 * 60_000;
/** A wait on its own command is checked at least this often: its nudge's grace is minutes. */
export const COMMAND_MAX_EVERY_MS = 5 * 60_000;
export const DEADLINE_MS = 24 * 3600_000;
export const COMMAND_DEADLINE_MS = 4 * 3600_000;
export const OVERDUE_EVERY_MS = 3600_000;

/** The latest time a job may name to be woken at, after its wait began. */
export const MAX_WAKE_MS = 7 * 24 * 3600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 24 * 3600_000 };
const DURATION = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;

function durationMs(text: string): number | undefined {
  const m = DURATION.exec(text.trim());
  const ms = m ? Number(m[1]) * UNITS[m[2]!.charAt(0).toLowerCase()]! : NaN;
  return ms > 0 ? ms : undefined;
}

/**
 * A `check:` line, for a wait that began at `sinceMs`; undefined when it reads as none. A check-in is kept to a minute..a
 * week (a wait the hopper can test is checked at most MAX_EVERY_MS apart all the same, `newCheck`), a time to wake at to
 * the wait..a week after.
 */
export function checkAskOf(line: string, sinceMs: number): CheckAsk | undefined {
  const m = /^(in|every|after|at)\s+(.+)$/i.exec(line.trim());
  if (!m) return undefined;
  const word = m[1]!.toLowerCase(), rest = m[2]!;
  const clampAt = (ms: number): CheckAsk => ({ at: iso(Math.min(Math.max(ms, sinceMs), sinceMs + MAX_WAKE_MS)) });
  if (word === 'at') {
    const t = /^\d{4}-\d{2}-\d{2}T/.test(rest) ? Date.parse(rest) : NaN;
    return Number.isNaN(t) ? undefined : clampAt(t);
  }
  const ms = durationMs(rest);
  if (ms === undefined) return undefined;
  return word === 'after' ? clampAt(sinceMs + ms) : { inMs: Math.min(Math.max(ms, FIRST_CHECK_MS), MAX_WAKE_MS) };
}

/** What the job named on its wait's `check:` line, if anything. */
const askOf = (w: Pick<JobWait, 'checkLine' | 'since'> | undefined): CheckAsk | undefined => (w?.checkLine ? checkAskOf(w.checkLine, Date.parse(w.since)) : undefined);

/**
 * What the hopper can test of `job`'s wait. A wait it cannot test, with a time the job named: that time. An outside event it
 * watches nothing of (or a wait with nothing recorded), with a check-in the job named: a recheck at it (issue #2335). Else
 * `none`: an approval, a grant or a plan is woken by the event that settles it, and an outside event by a person who ends
 * the wait (issue #2338), so the job holds no agent and is not woken to look again and again.
 */
export function conditionOf(job: Pick<Job, 'id' | 'status' | 'wait' | 'source'>): WaitCondition {
  const c = baseCondition(job);
  if (c.kind !== 'none') return c;
  const ask = askOf(job.wait);
  if (ask && 'at' in ask) return { kind: 'time_passed', at: ask.at };
  const on = job.wait?.on;
  if ((on && on.kind !== 'outside') || !ask) return c;
  return { kind: 'recheck', at: iso(Date.parse(job.wait!.since) + ask.inMs) };
}

function baseCondition(job: Pick<Job, 'id' | 'status' | 'wait' | 'source'>): WaitCondition {
  const on = job.wait?.on;
  if (job.wait?.ownCommand || on?.kind === 'own_command') return { kind: 'command_exited' };
  if (on?.kind === 'job') return { kind: 'job_ended', jobId: on.jobId };
  if (on?.kind === 'question') return { kind: 'question_settled', questionId: on.questionId };
  if (on?.kind === 'pull_request') {
    const repo = on.repo ?? job.source?.repo;
    if (!repo) return { kind: 'none' };
    if (on.about === 'checks') return { kind: 'pr_checks_ended', repo, number: on.number };
    if (on.about === 'review') return { kind: 'pr_review_ended', repo, number: on.number };
    return { kind: 'items_ended', refs: [{ kind: 'issue', repo, number: on.number }] };
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
    case 'pr_checks_ended':
    case 'pr_review_ended': return `${c.kind}:${c.repo.toLowerCase()}#${c.number}`;
    case 'time_passed':
    case 'recheck': return `${c.kind}:${c.at}`;
    default: return c.kind;
  }
}

/** An item as a person reads it. */
export const refLabel = (r: WatchedRef): string => (r.kind === 'issue' ? `${r.repo}#${r.number}` : `${r.repo} run ${r.runId}`);

/**
 * The check of a new wait: a minute after it began, or at the check-in the job named; a wait flagged stuck before (issue
 * #1037) at once. A time the job named to be woken at: its condition's time, or `wakeAt` beside its condition; never checked
 * later than it, and its deadline an hour past it at least. `wokenFor`: the condition the hopper last woke the job for.
 */
export function newCheck(job: Pick<Job, 'id' | 'status' | 'wait' | 'source'>, nowMs: number, wokenFor?: string): WaitCheck {
  const w = job.wait!;
  const condition = conditionOf(job);
  const ask = askOf(w);
  const since = Date.parse(w.since);
  const everyMs = ask && 'inMs' in ask ? Math.min(ask.inMs, MAX_EVERY_MS) : FIRST_CHECK_MS;
  const wake = ask && 'at' in ask ? Date.parse(ask.at) : undefined;
  // Issue #2459: a recheck is at the check-in the job named, however long; its deadline comes after it.
  const due = condition.kind === 'recheck' ? Date.parse(condition.at) : wake;
  // A time the hopper only waits for is checked at that time, not before.
  const next = w.stuckAt ? nowMs : condition.kind === 'time_passed' ? wake! : condition.kind === 'recheck' ? Date.parse(condition.at) : Math.min(since + everyMs, wake ?? Infinity);
  const deadline = Math.max(since + (condition.kind === 'command_exited' ? COMMAND_DEADLINE_MS : DEADLINE_MS), (due ?? 0) + OVERDUE_EVERY_MS);
  const repeat = condition.kind === 'items_ended' && wokenFor === conditionKey(condition);
  return {
    condition, nextCheckAt: iso(next), everyMs, attempts: 0, deadline: iso(deadline), ...(repeat ? { repeat: true as const } : {}),
    ...(wake !== undefined && condition.kind !== 'time_passed' ? { wakeAt: iso(wake) } : {}),
  };
}

/** The check after one not met at `nowMs`: tried again later, the time between doubling. `overdue`: it passed its deadline now. */
export function afterCheck(check: WaitCheck, result: string, nowMs: number, overdueNow = false): { check: WaitCheck; overdue: boolean } {
  const past = overdueNow || nowMs >= Date.parse(check.deadline);
  const overdue = past && !check.overdueAt;
  const cap = check.condition.kind === 'command_exited' ? COMMAND_MAX_EVERY_MS : MAX_EVERY_MS;
  const wait = past ? OVERDUE_EVERY_MS : Math.min(check.everyMs, cap);
  const everyMs = past ? OVERDUE_EVERY_MS : Math.min(check.everyMs * 2, cap);
  const c = check.condition;
  const wake = check.wakeAt ? Date.parse(check.wakeAt) : c.kind === 'time_passed' || c.kind === 'recheck' ? Date.parse(c.at) : undefined;
  // A recheck has nothing to test before its time.
  const nextMs = wake !== undefined && wake > nowMs ? (c.kind === 'recheck' ? wake : Math.min(nowMs + wait, wake)) : nowMs + wait;
  const next: WaitCheck = {
    ...check, attempts: check.attempts + 1, checkedAt: iso(nowMs), result, nextCheckAt: iso(nextMs), everyMs,
    ...(overdue ? { overdueAt: iso(nowMs) } : {}),
  };
  return { check: next, overdue };
}

/** What the job is told when its check ends its wait. */
export const checkEndedNote = (w: Pick<JobWait, 'for' | 'on'> | undefined, note: string): string =>
  `[hopper] The hopper ended your wait (${w?.on ? waitOnLabel(w.on) : w?.for ?? 'what you waited on'}): ${note}. Check it, then go on with the job.`;

/** A recheck (issue #2335): met at its time, and the job is told to look again and how to wait again. */
export function recheckOutcome(c: Extract<WaitCondition, { kind: 'recheck' }>, w: Pick<JobWait, 'for' | 'on'>, nowMs: number): CheckOutcome {
  if (nowMs < Date.parse(c.at)) return { met: false, result: `it looks again at ${c.at}` };
  const what = w.on?.kind === 'outside' ? w.on.what : w.for;
  return {
    met: true, note: `the hopper cannot see what the job waits on; it woke the job to look again (${iso(nowMs)})`,
    told: `[hopper] The hopper cannot see what you wait on (${what}), so it woke you to look again. Your session ended while you waited, with any command you left in the background. Check it now. If it did not happen yet, end your turn with HOPPER_WAITING again: on: names what the hopper can check where you can (pr <number> merge or checks, issue <number>, job <id>), and check: in <time> says when to look again. Else go on with the job.`,
  };
}

/** What a job on its own command is told when the hopper ends that wait. */
const commandNote = (why: string): string =>
  `[hopper] The hopper ended your wait on your own command: ${why}. Read the command's output. If it still runs and you still wait on it, end your turn with HOPPER_WAITING again. Else go on with the job.`;

/** A pull request a wait on its checks names, as the job's source reads it (part 2): `not_found`, it names no pull request. */
export interface WaitedChecks { url: string; state: 'open' | 'closed' | 'merged' | 'not_found'; checks?: ChecksState; headCommittedAt?: string }

/** How long after a push a pull request with no checks is taken as having none (as yolo mode waits, issue #677). */
export const NO_CHECKS_MS = 2 * 60_000;

/** A wait on a pull request's checks: met when they passed or failed, when it ended, or when none started two minutes after its last push. */
export function checksOutcome(pr: WaitedChecks, nowMs: number): CheckOutcome {
  if (pr.state === 'not_found') return { met: true, note: `${pr.url} is no pull request. Name the right one if you still wait on it` };
  if (pr.state !== 'open') return { met: true, note: `${pr.url} was ${pr.state}` };
  switch (pr.checks) {
    case 'passing': return { met: true, note: `the checks of ${pr.url} passed` };
    case 'failing': return { met: true, note: `the checks of ${pr.url} failed` };
    case 'pending': return { met: false, result: `the checks of ${pr.url} run` };
    case 'unknown': return { met: false, result: `the hopper cannot read the checks of ${pr.url}` };
  }
  const pushed = pr.headCommittedAt ? Date.parse(pr.headCommittedAt) : NaN;
  return !Number.isNaN(pushed) && nowMs - pushed < NO_CHECKS_MS ? { met: false, result: `no checks of ${pr.url} started yet` } : { met: true, note: `${pr.url} has no checks` };
}

/** A review of a pull request, as the job's source reads it (part 3): `approved`, `changes_requested`, `commented`, `dismissed`. */
export interface WaitedReview { state: string; submittedAt?: string }

/** A pull request a wait on its review names (part 3); `reviews` absent: the source cannot read them. */
export interface WaitedReviews { url: string; state: 'open' | 'closed' | 'merged' | 'not_found'; reviews?: WaitedReview[] }

const REVIEW_SAYS: Record<string, string> = { approved: 'was approved', changes_requested: 'got a review that asks for changes', commented: 'got a review with comments', dismissed: 'had a review dismissed' };

/**
 * A wait on a pull request's review: met when a review came after the wait began (the newest one says what), or when it ended.
 * A review from before the wait is the one the job already read, so it does not count: else a job that pushed a fix and waits
 * for a new review is woken at once, again and again.
 */
export function reviewOutcome(pr: WaitedReviews, sinceMs: number): CheckOutcome {
  if (pr.state === 'not_found') return { met: true, note: `${pr.url} is no pull request. Name the right one if you still wait on it` };
  if (pr.state !== 'open') return { met: true, note: `${pr.url} was ${pr.state}` };
  if (!pr.reviews) return { met: false, result: `the hopper cannot read the reviews of ${pr.url}` };
  const after = pr.reviews.filter((r) => r.submittedAt !== undefined && Date.parse(r.submittedAt) >= sinceMs);
  const newest = after.sort((x, y) => Date.parse(x.submittedAt!) - Date.parse(y.submittedAt!)).at(-1);
  if (!newest) return { met: false, result: `no review of ${pr.url} since the wait began` };
  return { met: true, note: `${pr.url} ${REVIEW_SAYS[newest.state] ?? `got a review (${newest.state})`}` };
}

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

/**
 * The leases on wait checks (issue #1694): one hopper tests a job's wait check at a time; a lease ends by itself, `ms`
 * after its claim on the database's clock (issue #1954), never on a hopper's own.
 */
export interface WaitCheckLeases {
  /** True when `owner` now holds the job's lease for `ms`: it was free, ended, its own, or for an older wait. */
  claim(jobId: string, since: string, owner: string, ms: number): boolean;
  /** True while `owner` holds the job's lease and it has not ended. */
  holds(jobId: string, owner: string): boolean;
  release(jobId: string, owner: string): void;
}
