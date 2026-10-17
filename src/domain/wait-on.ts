// What a job's own wait waits on (issue #1245, design.md "What a wait waits on"): typed, so the UI and an operator can
// tell whether to act, and the hopper can wake the job when it comes. The job names it on an `on:` line after
// HOPPER_WAITING; with none, it is read from its `for:` and `until:`, and what reads as nothing else is an outside event.
// A job never enters `waiting_on` without one (`waitEntryProblem`, checked where a job is written). The event that settles
// it wakes the job (`settledBy`, `waitsFor`; engine/wait.ts). The items an item or outside wait names are watched too
// (issue #1508, watched-items.ts). Pure.
import type { EventType } from './event-types.ts';
import { namesOwnCommand } from './own-command.ts';
import type { Job } from './types.ts';
import { endedNote } from './watched-items.ts';
import type { WorkItem } from './work-items.ts';

/** What about a pull request a job waits on. */
export type PullRequestWait = 'checks' | 'merge' | 'review';

/**
 * Why a person must act on an outside event (issue #1510): the repository is not one the hopper works on, or the step is
 * gated (an infrastructure apply, a gitops apply, a production approval). Absent: the job did not say, and the wait is flagged.
 */
export type OutsideWhy = 'not_managed' | 'gated';

/** What a job's own wait waits on. `repo` absent: the job's own repository. */
export type WaitOn =
  | { kind: 'pull_request'; repo?: string; number: number; about: PullRequestWait }
  | { kind: 'job'; jobId: string }
  | { kind: 'item'; repo?: string; number: number }
  | { kind: 'question'; questionId: string }
  | { kind: 'approval'; of: 'sandbox' | 'template' }
  | { kind: 'grant' }
  | { kind: 'own_command' }
  | { kind: 'outside'; what: string; why?: OutsideWhy };

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

const OUTSIDE_WHY: [RegExp, OutsideWhy][] = [[/^not\s+managed\b\s*[:\-–—]?\s*/i, 'not_managed'], [/^gated\b\s*[:\-–—]?\s*/i, 'gated']];

/** An outside event, with why a person acts when its text starts with it: `not managed: <what>`, `gated: <what>`. */
function outsideOf(text: string): WaitOn {
  for (const [re, why] of OUTSIDE_WHY) {
    const m = re.exec(text);
    if (m) return { kind: 'outside', what: text.slice(m[0].length) || text, why };
  }
  return { kind: 'outside', what: text };
}

/** An `on:` line, as the job rules say to write it; undefined when it reads as none of them. */
function onLine(on: string): WaitOn | undefined {
  const s = on.trim();
  const outside = /^outside\b:?\s*(.*)$/i.exec(s);
  if (outside) return outsideOf(outside[1] || s);
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

const OUTSIDE_WHY_WORDS: Record<OutsideWhy, string> = { not_managed: 'not managed', gated: 'gated' };

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
    case 'outside': return `outside (${on.why ? OUTSIDE_WHY_WORDS[on.why] : 'reason not given'}): ${on.what}`;
  }
}

/** Why `next` may not be written: it enters `waiting_on` with nothing it waits on. A wait kept as it was is never refused. */
export function waitEntryProblem(cur: Pick<Job, 'status'>, next: Pick<Job, 'id' | 'status' | 'wait'>): string | undefined {
  if (next.status !== 'waiting_on' || cur.status === 'waiting_on' || next.wait?.on) return undefined;
  return `job ${next.id} waits on nothing recorded: a job enters waiting_on only with what it waits on`;
}

/** What an event settles (issue #1245): the dependency it ends, and what happened, in a few words. */
export type Settled = { note: string } & (
  | { kind: 'pull_request' | 'item'; repo: string; number: number }
  | { kind: 'job'; jobId: string }
  | { kind: 'question'; questionId: string }
  | { kind: 'grant'; jobId: string }
  // Issue #1508: everything the job's wait names ended (watched-items.ts).
  | { kind: 'watched'; jobId: string });

const AT = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/;
const JOB_ENDS: Record<string, string> = { 'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'was cancelled' };
const QUESTION_ENDS: Record<string, string> = { 'question.answered': 'was answered', 'question.closed': 'was closed', 'question.dismissed': 'was dismissed', 'question.expired': 'expired' };

/** Every event type `settledBy` reads (issue #1571: the hopper reads them again for a wake a stop lost). */
export const SETTLING_EVENT_TYPES: readonly EventType[] = [
  'job.pull_request_merged', 'job.pull_request_closed', 'job.waited_pull_request_ended', 'work_item.issue_closed', 'job.waited_items_ended',
  'vault.granted', 'vault.grant_denied', 'job.finished', 'job.failed', 'job.cancelled',
  'question.answered', 'question.closed', 'question.dismissed', 'question.expired',
];

/**
 * The dependency `e` settles, if any: what wakes the jobs waiting on it, on that event, never a poll. An approval is not
 * here: a job asks for one through a skill request, whose watch ends its wait with the answer once it is ready (issue #998,
 * src/skills/waits.ts) — the box started, not only the template approved.
 */
export function settledBy(e: { type: string; jobId?: string; data?: unknown }): Settled | undefined {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof d[k] === 'string' ? d[k] : undefined);
  const at = (url: string | undefined) => { const m = url ? AT.exec(url) : null; return m ? { repo: m[1]!, number: Number(m[2]) } : undefined; };
  switch (e.type) {
    case 'job.pull_request_merged': case 'job.pull_request_closed': {
      const pr = at(str('pullRequest'));
      return pr && { kind: 'pull_request', ...pr, note: `${str('pullRequest')} was ${e.type === 'job.pull_request_merged' ? 'merged' : 'closed'}` };
    }
    // Issue #1433: a sync read a waited pull request that no follow records ended.
    case 'job.waited_pull_request_ended': {
      const pr = at(str('pullRequest'));
      return pr && { kind: 'pull_request', ...pr, note: `${str('pullRequest')} was ${str('state') === 'merged' ? 'merged' : 'closed'}` };
    }
    case 'work_item.issue_closed': {
      const item = at(str('key'));
      return item && { kind: 'item', ...item, note: `${str('key')} was closed` };
    }
    case 'job.waited_items_ended': {
      const items = Array.isArray(d.items) ? (d.items as { url: string; state: string }[]) : [];
      return e.jobId ? { kind: 'watched', jobId: e.jobId, note: endedNote(items) } : undefined;
    }
    case 'vault.granted': case 'vault.grant_denied':
      return e.jobId ? { kind: 'grant', jobId: e.jobId, note: `a vault grant was ${e.type === 'vault.granted' ? 'given' : 'denied'}` } : undefined;
  }
  if (JOB_ENDS[e.type]) return e.jobId ? { kind: 'job', jobId: e.jobId, note: `job ${e.jobId} ${JOB_ENDS[e.type]}` } : undefined;
  const q = str('questionId');
  if (QUESTION_ENDS[e.type] && q) return { kind: 'question', questionId: q, note: `question ${q} ${QUESTION_ENDS[e.type]}` };
  return undefined;
}

/** True when `job` is on its own wait on what `s` settled. A pull request or an item with no repository named is in the job's own. */
export function waitsFor(job: Pick<Job, 'id' | 'status' | 'wait' | 'source'>, s: Settled): boolean {
  const on = job.wait?.on;
  if (job.status === 'waiting_on' && s.kind === 'watched') return job.id === s.jobId;
  if (job.status !== 'waiting_on' || !on || on.kind !== s.kind) return false;
  switch (on.kind) {
    case 'pull_request': case 'item': return 'number' in s && on.number === s.number && (on.repo ?? job.source?.repo) === s.repo;
    case 'job': return 'jobId' in s && on.jobId === s.jobId;
    case 'question': return 'questionId' in s && on.questionId === s.questionId;
    case 'grant': return 'jobId' in s && job.id === s.jobId;
    default: return false;
  }
}

/** A pull request jobs on their own wait name, and those jobs (issue #1433). */
export interface WaitedPullRequest { repo: string; number: number; jobIds: string[] }

/**
 * The pull requests the jobs on their own wait name (issue #1433), each once, in the repository the wait names or its job's
 * own; a wait with neither is left out. A sync reads each, so a job wakes when it ends though no job follows it.
 */
export function waitedPullRequests(jobs: Pick<Job, 'id' | 'status' | 'wait' | 'source'>[]): WaitedPullRequest[] {
  const out = new Map<string, WaitedPullRequest>();
  for (const j of jobs) {
    const on = j.wait?.on;
    if (j.status !== 'waiting_on' || on?.kind !== 'pull_request') continue;
    const repo = on.repo ?? j.source?.repo;
    if (!repo) continue;
    const k = `${repo.toLowerCase()}#${on.number}`;
    const w = out.get(k) ?? { repo, number: on.number, jobIds: [] };
    w.jobIds.push(j.id);
    out.set(k, w);
  }
  return [...out.values()];
}

/** A legacy wait (before issue #1245) names nothing it waits on, unless it was on its own command: stuck work, "waiting on nothing recorded". */
export const waitsOnNothing = (job: Pick<Job, 'status' | 'wait'>): boolean => job.status === 'waiting_on' && !job.wait?.on && !job.wait?.ownCommand;

/** What the work-item ledger says of an issue (by its URL) and of a pull request (by its URL): `settledAlready` reads it. */
export interface SettledLookup {
  get(key: string): Pick<WorkItem, 'issueState'> | undefined;
  byPullRequest(url: string): Pick<WorkItem, 'pullRequest' | 'pullRequestState'> | undefined;
}

/**
 * What already settled a wait as it starts (issue #1356): its issue closed, or its pull request merged or closed, as the
 * work-item ledger holds it. No event comes for it any more, so the hopper ends the wait at once, as that event would.
 * `ownRepo`: the job's own repository, for a wait that names none. Undefined: it still waits.
 */
export function settledAlready(on: WaitOn, ownRepo: string | undefined, ledger: SettledLookup): Settled | undefined {
  if (on.kind !== 'item' && !(on.kind === 'pull_request' && on.about === 'merge')) return undefined;
  const repo = on.repo ?? ownRepo;
  if (!repo) return undefined;
  if (on.kind === 'item') {
    const url = `https://github.com/${repo}/issues/${on.number}`;
    return ledger.get(url)?.issueState === 'closed' ? { kind: 'item', repo, number: on.number, note: `${url} was closed` } : undefined;
  }
  const url = `https://github.com/${repo}/pull/${on.number}`;
  const state = ledger.byPullRequest(url)?.pullRequestState;
  return state === 'merged' || state === 'closed' ? { kind: 'pull_request', repo, number: on.number, note: `${url} was ${state}` } : undefined;
}
