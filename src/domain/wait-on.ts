// What a job's own wait waits on (issue #1245, design.md "What a wait waits on"): typed, so the UI and an operator can
// tell whether to act, and the hopper can wake the job when it comes. The job names it on an `on:` line after
// HOPPER_WAITING; with none, it is read from its `for:` and `until:`, and what reads as nothing else is an outside event.
// A job never enters `waiting_on` without one (`waitEntryProblem`, checked where a job is written). The event that settles
// it wakes the job (`settledBy`, `waitsFor`; engine/wait.ts). The items an item or outside wait names are watched too
// (issue #1508, watched-items.ts). An infra plan's approval (issue #2205): the plan must be recorded where Infra and Needs you
// read it; else, or once nobody can approve it, the wait ends at once and the job is told why (`planWaitEnd`). Pure.
import type { EventType } from './event-types.ts';
import { failedChecks, rejectedWords, type InfraPlan, type PlanApproval, type PlanRejection } from './infra-plans.ts';
import { namesOwnCommand } from './own-command.ts';
import { nameWithoutEmail } from './users.ts';
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
  // Issue #2205: a person's approval of the infra plan of this id.
  | { kind: 'plan'; planId: string }
  | { kind: 'own_command' }
  | { kind: 'outside'; what: string; why?: OutsideWhy };

export type WaitOnKind = WaitOn['kind'];

/** What a job wrote after HOPPER_WAITING. `check` (issue #1694): its `check:` line, when the hopper checks next or a time to wake it at. */
export interface WaitAsked { for: string; until?: string; on?: string; check?: string }

const REPO = String.raw`([\w.-]+\/[\w.-]+)`;
const PR_AT = new RegExp(String.raw`(?:${REPO}#|\b(?:pr|pull\s+request)\s*#?)(\d+)`, 'i');
const ITEM_AT = new RegExp(String.raw`(?:${REPO}#|\b(?:issue|item)\s*#?)(\d+)`, 'i');

function aboutOf(text: string): PullRequestWait {
  if (/\bcheck/i.test(text)) return 'checks';
  if (/\breview/i.test(text)) return 'review';
  return 'merge';
}

/** A repository the text names in a link or in words: `in owner/name`, `repository owner/name`. */
const NAMED_REPO = /(?:github\.com\/|\b(?:in|repo|repository)\s+`?)([A-Za-z0-9][\w.-]*\/[\w.-]*[\w-])/gi;

/**
 * The repository of a number at `at` written with no owner (issue #2090): the one the text names after it, else the last
 * before it; none when the text names none, and the number is in the job's own repository.
 */
function repoAt(text: string, at: number): string | undefined {
  const named = [...text.matchAll(NAMED_REPO)];
  return (named.find((m) => m.index > at) ?? named.filter((m) => m.index < at).at(-1))?.[1];
}

/** The repository and number a match of PR_AT or ITEM_AT names: its own `owner/name#`, else the one the text names. */
function numberedIn(text: string, m: RegExpExecArray): { repo?: string; number: number } {
  const repo = m[1] ?? repoAt(text, m.index);
  return { ...(repo ? { repo } : {}), number: Number(m[2]) };
}

function pullRequestIn(text: string): WaitOn | undefined {
  const m = PR_AT.exec(text);
  return m ? { kind: 'pull_request', ...numberedIn(text, m), about: aboutOf(text) } : undefined;
}

function approvalIn(text: string): WaitOn | undefined {
  if (/\btemplate\b/i.test(text) && /\b(?:approv|sandbox)/i.test(text)) return { kind: 'approval', of: 'template' };
  if (/\bsandbox\b/i.test(text) && /\bapprov/i.test(text)) return { kind: 'approval', of: 'sandbox' };
  return undefined;
}

/** An infra plan named by its id (issue #2205): `infra plan <id>`, `plan <id>`. A sandbox's plan has no id, so it never reads as one. */
const PLAN_AT = /\bplan\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

function planIn(text: string): WaitOn | undefined {
  const m = PLAN_AT.exec(text);
  return m ? { kind: 'plan', planId: m[1]!.toLowerCase() } : undefined;
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
  // An infra plan's approval, though the job wrote it as an outside event (issue #2205): the hopper knows where it waits.
  const plan = planIn(s);
  if (plan) return plan;
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
    if (m) return { kind: 'item', ...numberedIn(s, m) };
  }
  return pullRequestIn(s);
}

/** What the wait waits on: its `on:` line, else what its `for:` and `until:` say, else an outside event. Never none. */
export function waitOnOf(w: WaitAsked): WaitOn {
  if (w.on?.trim()) return onLine(w.on) ?? { kind: 'outside', what: w.on.trim() };
  if (namesOwnCommand(w)) return { kind: 'own_command' };
  const text = `${w.for} ${w.until ?? ''}`;
  return planIn(text) ?? approvalIn(text) ?? (/\bgrant\b/i.test(text) ? { kind: 'grant' } : undefined) ?? pullRequestIn(text) ?? { kind: 'outside', what: w.for };
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
    case 'plan': return `approval of infra plan ${on.planId}`;
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
  | { kind: 'plan'; planId: string }
  // Issue #1508: everything the job's wait names ended (watched-items.ts).
  | { kind: 'watched'; jobId: string });

const AT = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/;
const JOB_ENDS: Record<string, string> = { 'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'was cancelled' };
const QUESTION_ENDS: Record<string, string> = { 'question.answered': 'was answered', 'question.closed': 'was closed', 'question.dismissed': 'was dismissed', 'question.expired': 'expired', 'question.cancelled': 'was cancelled' };

/** Every event type `settledBy` reads (issue #1571: the hopper reads them again for a wake a stop lost). */
export const SETTLING_EVENT_TYPES: readonly EventType[] = [
  'job.pull_request_merged', 'job.pull_request_closed', 'job.waited_pull_request_ended', 'work_item.issue_closed', 'job.waited_items_ended',
  'vault.granted', 'vault.grant_denied', 'vault.action_granted', 'vault.action_declined', 'infra.plan_approved', 'infra.plan_rejected', 'job.finished', 'job.failed', 'job.cancelled',
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
    case 'infra.plan_approved': {
      const plan = str('plan');
      return plan ? { kind: 'plan', planId: plan, note: `infra plan ${plan} was approved by ${nameWithoutEmail(str('by') ?? 'a person')}` } : undefined;
    }
    // Issue #2368: a rejected plan is never approved, so its wait ends with who rejected it and why.
    case 'infra.plan_rejected': {
      const plan = str('plan');
      return plan ? { kind: 'plan', planId: plan, note: `infra ${rejectedWords(plan, { by: nameWithoutEmail(str('by') ?? 'a person'), note: str('note') ?? 'no note' })}` } : undefined;
    }
    // Issue #2206: an action grant a job's need step asked for.
    case 'vault.action_granted': case 'vault.action_declined':
      return e.jobId ? { kind: 'grant', jobId: e.jobId, note: `an action grant (${str('action')} on ${str('resource')}) was ${e.type === 'vault.action_granted' ? 'given' : 'declined'}` } : undefined;
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
    case 'plan': return 'planId' in s && on.planId === s.planId;
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

/**
 * How a wait on an infra plan ends as it starts (issue #2205), or undefined while a person can approve it: approved already,
 * it is settled; not recorded, rejected (issue #2368), stale, or failed its checks, no person can see or approve it, so the job is told why
 * (`told`) rather than wait on something nobody acts on. `plan`: the plan of that id, as the job's user's store keeps it.
 */
export function planWaitEnd(planId: string, plan: Pick<InfraPlan, 'id' | 'expiresAt' | 'summary'> | undefined, approval: Pick<PlanApproval, 'by'> | undefined, now: Date, rejection?: Pick<PlanRejection, 'by' | 'note'>): { settled: Settled } | { told: string } | undefined {
  if (plan && rejection) return { told: `infra ${rejectedWords(planId, { by: nameWithoutEmail(rejection.by), note: rejection.note })}` };
  if (!plan) return { told: `no infra plan ${planId} is recorded on this hopper, so no person can see or approve it. Record the plan with POST /job/infra-plans; its answer names the plan's id. Then wait with on: infra plan <that id>` };
  if (approval) return { settled: { kind: 'plan', planId, note: `infra plan ${planId} was approved by ${nameWithoutEmail(approval.by)}` } };
  const failed = failedChecks(plan);
  if (failed) return { told: `infra plan ${planId} failed its checks, so nobody approves it: ${failed}. Fix the code, plan again, and record the new plan` };
  if (now.getTime() >= Date.parse(plan.expiresAt)) return { told: `infra plan ${planId} is stale since ${plan.expiresAt}, so nobody approves it. Plan again, record the new plan, and wait on it` };
  return undefined;
}
