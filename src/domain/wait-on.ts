// What a job's own wait waits on (issue #1245, design.md "What a wait waits on"): typed, so the UI and an operator can
// tell whether to act, and the hopper can wake the job when it comes. The job names it on an `on:` line after
// HOPPER_WAITING; with none, it is read from its `for:` and `until:`, and what reads as nothing else is an outside event.
// A job never enters `waiting_on` without one (`waitEntryProblem`, checked where a job is written). Pure.
import { namesOwnCommand } from './own-command.ts';
import type { Job } from './types.ts';

/** What about a pull request a job waits on. */
export type PullRequestWait = 'checks' | 'merge' | 'review';

/** What a job's own wait waits on. `repo` absent: the job's own repository. */
export type WaitOn =
  | { kind: 'pull_request'; repo?: string; number: number; about: PullRequestWait }
  | { kind: 'job'; jobId: string }
  | { kind: 'item'; repo?: string; number: number }
  | { kind: 'question'; questionId: string }
  | { kind: 'approval'; of: 'sandbox' | 'template' }
  | { kind: 'grant' }
  | { kind: 'own_command' }
  | { kind: 'outside'; what: string };

export type WaitOnKind = WaitOn['kind'];

/** What a job wrote after HOPPER_WAITING. */
export interface WaitAsked { for: string; until?: string; on?: string }

const REPO = String.raw`([\w.-]+\/[\w.-]+)`;
const PR_AT = new RegExp(String.raw`(?:${REPO}#|\b(?:pr|pull\s+request)\s*#?)(\d+)`, 'i');
const ITEM_AT = new RegExp(String.raw`(?:${REPO}#|\b(?:issue|item)\s*#?)(\d+)`, 'i');

function aboutOf(text: string): PullRequestWait {
  if (/\bcheck/i.test(text)) return 'checks';
  if (/\breview/i.test(text)) return 'review';
  return 'merge';
}

function pullRequestIn(text: string): WaitOn | undefined {
  const m = PR_AT.exec(text);
  return m ? { kind: 'pull_request', ...(m[1] ? { repo: m[1] } : {}), number: Number(m[2]), about: aboutOf(text) } : undefined;
}

function approvalIn(text: string): WaitOn | undefined {
  if (/\btemplate\b/i.test(text) && /\b(?:approv|sandbox)/i.test(text)) return { kind: 'approval', of: 'template' };
  if (/\bsandbox\b/i.test(text) && /\bapprov/i.test(text)) return { kind: 'approval', of: 'sandbox' };
  return undefined;
}

/** An `on:` line, as the job rules say to write it; undefined when it reads as none of them. */
function onLine(on: string): WaitOn | undefined {
  const s = on.trim();
  const outside = /^outside\b:?\s*(.*)$/i.exec(s);
  if (outside) return { kind: 'outside', what: outside[1] || s };
  if (/^own\s+command\b/i.test(s)) return { kind: 'own_command' };
  const job = /^job\s+(\S+)$/i.exec(s);
  if (job) return { kind: 'job', jobId: job[1]! };
  const question = /^question\s+(\S+)$/i.exec(s);
  if (question) return { kind: 'question', questionId: question[1]! };
  if (/^(?:vault\s+)?grant\b/i.test(s)) return { kind: 'grant' };
  const approval = approvalIn(s);
  if (approval) return approval;
  if (/^(?:issue|item)\b/i.test(s)) {
    const m = ITEM_AT.exec(s);
    if (m) return { kind: 'item', ...(m[1] ? { repo: m[1] } : {}), number: Number(m[2]) };
  }
  return pullRequestIn(s);
}

/** What the wait waits on: its `on:` line, else what its `for:` and `until:` say, else an outside event. Never none. */
export function waitOnOf(w: WaitAsked): WaitOn {
  if (w.on?.trim()) return onLine(w.on) ?? { kind: 'outside', what: w.on.trim() };
  if (namesOwnCommand(w)) return { kind: 'own_command' };
  const text = `${w.for} ${w.until ?? ''}`;
  return approvalIn(text) ?? (/\bgrant\b/i.test(text) ? { kind: 'grant' } : undefined) ?? pullRequestIn(text) ?? { kind: 'outside', what: w.for };
}

const PR_ABOUT: Record<PullRequestWait, string> = { merge: 'to merge', checks: 'checks to end', review: 'review' };

/** The dependency in a few words, as the UI shows it. */
export function waitOnLabel(on: WaitOn): string {
  switch (on.kind) {
    case 'pull_request': return `${on.repo ? `${on.repo}#` : 'PR #'}${on.number} ${PR_ABOUT[on.about]}`;
    case 'job': return `job ${on.jobId}`;
    case 'item': return `${on.repo ? `${on.repo}#` : 'issue #'}${on.number}`;
    case 'question': return `a person's answer to question ${on.questionId}`;
    case 'approval': return `${on.of} approval`;
    case 'grant': return 'a vault grant';
    case 'own_command': return 'its own command';
    case 'outside': return `outside: ${on.what}`;
  }
}

/** Why `next` may not be written: it enters `waiting_on` with nothing it waits on. A wait kept as it was is never refused. */
export function waitEntryProblem(cur: Pick<Job, 'status'>, next: Pick<Job, 'id' | 'status' | 'wait'>): string | undefined {
  if (next.status !== 'waiting_on' || cur.status === 'waiting_on' || next.wait?.on) return undefined;
  return `job ${next.id} waits on nothing recorded: a job enters waiting_on only with what it waits on`;
}

/** True when `job` waits on the pull request at `url` (merged or closed: whatever it waited for about it is over). */
export function mergedWaiter(job: Pick<Job, 'status' | 'wait' | 'source'>, url: string): boolean {
  const on = job.wait?.on;
  if (job.status !== 'waiting_on' || on?.kind !== 'pull_request') return false;
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return !!m && Number(m[2]) === on.number && (on.repo ?? job.source?.repo) === m[1];
}

/** A legacy wait (before issue #1245) names nothing it waits on, unless it was on its own command: stuck work, "waiting on nothing recorded". */
export const waitsOnNothing = (job: Pick<Job, 'status' | 'wait'>): boolean => job.status === 'waiting_on' && !job.wait?.on && !job.wait?.ownCommand;
