// Which issues are taken, and why each other one is not (issue #440). Taken: open, labelled, assigned to the
// source's account (issue #387: who filed it does not matter), not done/failed/rejected/on the backburner, not
// addressed to another hopper (`hopper@<name>`, issue #159), not claimed by someone else, and not rejected by
// the user since it was last assigned (one events read, only for rejected issues). Every other open labelled
// issue gets one reason: nothing in scope is dropped without saying why.
//
// A claim names its holder (`hopper:held-by:<id>`, issue #440). A claimed issue with a local job is that job's.
// Without one: the user's own claim is stale and released, then taken; another holder's claim is respected —
// said to be another user's of this hopper when one of them has a job for it —, and the user may release it.
// A claim with no holder predates holders: the intake migration releases it once when no user of this hopper
// has a job for it; after that it is an older hopper's, respected like any other.
//
// A comment command (issue #655 part 21, domain/comment-command.ts) stands in for the assignment: a labelled issue not
// assigned to the account is taken when the account's newest command on it was not edited (its comments are read, only
// for such an issue). Its origin then reads the command as the nominating act (origin.ts), and after a rejection only a
// command written since takes it again.
//
// Intake reads the ledger (issue #1892): for an issue whose work item is in a state the label mirror judges (a job at work,
// PR open, blocked, failed as reported, done by a whole merge or by hand, partly done with parts left, needs you, a hand-off as reported, a request card, dropped by Won't do, dropped by a cancelled or rejected job as reported, with the label a person put on to keep it out, dropped by a tend job cancelled not on purpose as reported, dropped by a dismissed failure as reported, dropped by a person's Close PR or the hopper's own close; `labelsFor`), its end-label reason is the ledger's (`ledgerReason`), whatever end labels the issue
// carries — the mirror corrects them. The labels decide only for an issue the hopper does not know, or a state the mirror
// does not judge yet. An item a person asked to run again by taking its end label off (`runAgainAsked`, or `edited` in this
// pass) has no such reason, so it is taken again.
//
// The scope is given: a repo list (the app's installed repos, a connected account's chosen repos), its open labelled
// issues as the listing cache holds them (issue #985, `listing.ts`). Never a search: the app never passes an empty list,
// and a connected account's source with none chosen is paused (issue #321).

import { commandOf, type CommentCommand } from '../../domain/comment-command.ts';
import type { IntakeOutcome, NotTakenGroup } from '../../domain/intake.ts';
import type { Rejection } from '../../domain/rejection.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { HANDOFF_WAIT, type WorkItem } from '../../domain/work-items.ts';
import { labelsFor, type DropReport, type LabelFacts } from './item-labels.ts';
import {
  ADDRESS_PREFIX, HOLDER_PREFIX, LABEL_BACKBURNER, LABEL_BLOCKED, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY, LABEL_REJECTED, holderLabel,
} from './labels.ts';

/** A rejection with no assignee (a job taken before assignment intake) leaves its issue to its labels, as then. */
export type { Rejection } from '../../domain/rejection.ts';

export const NOT_ASSIGNED = 'not assigned to you';
export const BACKBURNER = 'on the backburner';
export const FAILED = 'failed: hopper:failed is on the issue';
export const DONE_OPEN = 'done, but the issue is still open';
export const PR_READY = 'done: its pull request waits for review';
export const PARTLY_DONE = 'partly done: the rest runs once its pull request merges';
export const PR_CLOSED = 'its pull request was closed without a merge: hopper:pr-closed is on the issue';
export const BLOCKED = 'blocked: no pull request was found for it; hopper:blocked is on the issue';
export const BLOCKED_STALE = 'blocked: it stayed past its deadline with no move, and waits on a person';
export const REJECTED_LABEL = 'rejected: hopper:rejected is on the issue';
export const REJECTED_BY_YOU = 'rejected by you: not taken until assigned to you again';
export const ADDRESSED_ELSEWHERE = 'addressed to another hopper';
export const CLAIMED_ELSEWHERE = 'claimed by another hopper';
export const CLAIMED_NO_HOLDER = 'claimed by another hopper (no holder recorded)';
export const CLAIMED_BY_OTHER_USER = 'claimed by another user of this hopper';
export const CLAIMED_STALE = 'claimed with no job here (stale)';
/** Without `knownKeys` nothing can tell a claim's job apart: every claimed issue is skipped (never re-run blind). */
export const CLAIMED_UNKNOWN = 'claimed: whether a job here holds it is not known';

/** A claim released at discovery: the user's own stale one, or (in the intake migration) one with no holder. */
export interface Released {
  key: string;
  by: 'hopper' | 'migration';
  reason: string;
}

export interface DiscoverResult {
  issues: GitHubIssue[];
  repoErrors: Record<string, string>;
  /** Every open labelled issue listed: taken (no reason), or the one reason it is not. */
  outcomes: IntakeOutcome[];
  /** The labels of every issue listed, by URL. */
  listed: Map<string, string[]>;
  /** Every open labelled issue listed, taken or not: what the issue graph keeps (issue #437). */
  seen: GitHubIssue[];
  released: Released[];
  /** The intake migration ran in this pass: it was asked for and every repo was listed. */
  migrated: boolean;
  /** The issues taken by a comment command in place of the assignment (issue #655 part 21), by URL. */
  nominated: Map<string, CommentCommand>;
}

type DiscoverConfig = Pick<GitHubSourceConfig, 'label' | 'hopperName'>;

export interface DiscoverScope {
  /** The scope's open labelled issues, and the repositories GitHub did not answer for (`listing.ts`). */
  listed: { issues: GitHubIssue[]; repoErrors: Record<string, string> };
  /** The login an issue must be assigned to. */
  assignee: string;
  knownKeys?: (keys: string[]) => Set<string>;
  rejections?: (keys: string[]) => Map<string, Rejection>;
  /** This user's claim holder id (issue #440); absent: claims are written with no holder and none is released. */
  holder?: string;
  /** Of these keys, those another user of this hopper has a job for. */
  othersKnown?: (keys: string[]) => Set<string>;
  /** True during the intake migration: a claim with no holder and no job anywhere in this hopper is released. */
  migrating?: boolean;
  /** The work item of an issue, by its URL (issue #1892): Intake's reason for a state the label mirror judges is the ledger's. */
  item?: (key: string) => WorkItem | undefined;
  /** Whether the open pull request of an item in PR open is a part. */
  part?: (key: string) => boolean;
  /** Whether a failed item's failure was reported to its issue as failed (`hopper:failed`). */
  failureReported?: (key: string) => boolean;
  /** Whether a partly done item's merged part leaves parts to run: no end label, so Intake takes it again. */
  partsLeft?: (key: string) => boolean;
  /** What a dropped item's cancelled or rejected job's report left (`DropReport`); undefined: not reported. */
  dropReported?: (key: string) => DropReport | undefined;
  /** Whether a done item's job's final report put `hopper:done` on. */
  doneReported?: (key: string) => boolean;
  /** The issues whose end label a person took off by hand, found in this pass (`work_item.label_edited`): no reason from the ledger. */
  edited?: ReadonlySet<string>;
}

/** GitHub logins compare without case. */
export const isAssignedTo = (i: Pick<GitHubIssue, 'assignees'>, login: string): boolean =>
  i.assignees.some((a) => a.toLowerCase() === login.toLowerCase());

/**
 * Intake's end-label reason from the ledger (issue #1892), for an item in a state the label mirror judges: PR open, its pull
 * request (or its part) waits for review; blocked, why; failed or handed off, as its failure was reported; done, its issue still open; dropped by Won't do, rejected;
 * dropped by a cancelled or rejected job, the reason of the label a person put on to keep it out; dropped by a tend job cancelled
 * not on purpose, its pull request waits for review; dropped by a dismissed failure, failed; dropped by a person's Close PR or the hopper's own close, pr-closed. `{}`: no such reason (a job at
 * work, a part merged with parts left, a cancelled or rejected job's item with no such label, or a person's Run again).
 * Undefined: the ledger does not decide (no item, or a state the mirror does not judge), so the labels do.
 */
export function ledgerReason(item: WorkItem | undefined, facts: LabelFacts): { reason?: string } | undefined {
  if (item === undefined || labelsFor(item, facts) === undefined) return undefined;
  if (item.runAgainAsked !== undefined) return {};
  if (item.state === 'pr_open') return { reason: facts.part ? PARTLY_DONE : PR_READY };
  if (item.state === 'failed' || (item.state === 'needs_you' && item.waitingOn === HANDOFF_WAIT)) return { reason: FAILED };
  if (item.state === 'done') return { reason: DONE_OPEN };
  if (item.state === 'dropped') return item.wontDo === true ? { reason: REJECTED_LABEL } : item.dismissed === true ? { reason: FAILED } : item.closedByPerson === true || item.closedByHopper === true ? { reason: PR_CLOSED } : item.keptOut !== undefined ? { reason: labelReason({ labels: [item.keptOut] }, null) } : facts.dropReported === 'pr_ready' ? { reason: PR_READY } : {};
  if (item.state === 'blocked') return { reason: item.blockedCause === 'pr_closed' ? PR_CLOSED : item.blockedCause === 'stale' ? BLOCKED_STALE : BLOCKED };
  return {};
}

/**
 * Why the issue keeps out, before assignment and claims are asked; undefined when it does not. Its end labels count only when
 * the ledger does not decide (`ledger` undefined); the backburner and an address to another hopper always count.
 */
export function labelReason(i: Pick<GitHubIssue, 'labels'>, name: string | null, ledger?: { reason?: string }): string | undefined {
  if (ledger) return ledger.reason ?? otherReason(i, name);
  if (i.labels.includes(LABEL_DONE)) return DONE_OPEN;
  if (i.labels.includes(LABEL_PR_READY)) return PR_READY;
  if (i.labels.includes(LABEL_PARTLY_DONE)) return PARTLY_DONE;
  if (i.labels.includes(LABEL_PR_CLOSED)) return PR_CLOSED;
  if (i.labels.includes(LABEL_BLOCKED)) return BLOCKED;
  if (i.labels.includes(LABEL_FAILED)) return FAILED;
  if (i.labels.includes(LABEL_REJECTED)) return REJECTED_LABEL;
  return otherReason(i, name);
}

/** The reasons no end label gives: the backburner, an address to another hopper. */
function otherReason(i: Pick<GitHubIssue, 'labels'>, name: string | null): string | undefined {
  if (i.labels.includes(LABEL_BACKBURNER)) return BACKBURNER;
  if (!forThisHopper(i, name)) return ADDRESSED_ELSEWHERE;
  return undefined;
}

/** An issue addressed to hoppers by name goes to those only; an unaddressed one to any. */
function forThisHopper(i: Pick<GitHubIssue, 'labels'>, name: string | null): boolean {
  const addressed = i.labels.filter((l) => l.startsWith(ADDRESS_PREFIX)).map((l) => l.slice(ADDRESS_PREFIX.length));
  return addressed.length === 0 || (name !== null && addressed.includes(name));
}

/** The rejected issues not assigned to the account, nor nominated by its command, again since their rejection. */
async function stillRejected(api: GitHubApi, issues: GitHubIssue[], scope: DiscoverScope, nominated: ReadonlyMap<string, CommentCommand>): Promise<Set<string>> {
  const rejected = scope.rejections && issues.length > 0 ? scope.rejections(issues.map((i) => i.url)) : new Map<string, Rejection>();
  const skipped = new Set<string>();
  for (const i of issues) {
    const r = rejected.get(i.url);
    if (!r?.assignee) continue;
    const command = nominated.get(i.url);
    if (command) { if (Date.parse(command.at) <= Date.parse(r.at)) skipped.add(i.url); continue; }
    const assigned = await api.assignedAt(i.repo, i.number, scope.assignee);
    if (assigned === undefined || Date.parse(assigned) <= Date.parse(r.at)) skipped.add(i.url);
  }
  return skipped;
}

/** An issue's comments, or none when they cannot be read: a command not read nominates nothing. */
async function commentsOf(api: GitHubApi, i: GitHubIssue) {
  try {
    return await api.listComments(i.repo, i.number);
  } catch (err) {
    console.warn(`hopper: the comments of ${i.url} could not be read: ${(err as Error).message}`);
    return [];
  }
}

/** A claim's labels: `hopper:claimed`, and this user's holder label when there is one. A release removes both. */
export const claimLabels = (holder: string | undefined): string[] => [LABEL_CLAIMED, ...(holder ? [holderLabel(holder)] : [])];

type ClaimVerdict = { kind: 'keep' } | { kind: 'release'; released: Released } | { kind: 'skip'; reason: string; action?: 'release' };

/** What to do with a claimed issue this user has no local job for. */
function claimVerdict(i: GitHubIssue, scope: DiscoverScope, otherUser: boolean): ClaimVerdict {
  const holders = i.labels.filter((l) => l.startsWith(HOLDER_PREFIX));
  const mine = scope.holder !== undefined && holders.includes(holderLabel(scope.holder));
  if (otherUser) return { kind: 'skip', reason: CLAIMED_BY_OTHER_USER };
  if (mine && holders.length === 1) {
    return { kind: 'release', released: { key: i.url, by: 'hopper', reason: 'claimed by this user of this hopper, with no job here' } };
  }
  if (holders.length > 0) return { kind: 'skip', reason: CLAIMED_ELSEWHERE, action: 'release' };
  if (scope.migrating) {
    return { kind: 'release', released: { key: i.url, by: 'migration', reason: 'claimed before claims named their holder, with no job in this hopper' } };
  }
  return { kind: 'skip', reason: CLAIMED_NO_HOLDER, action: 'release' };
}

/** The not-taken group of a reason (issue #798); a request card's is set where its origin is judged (source.ts). */
const GROUP_OF: Record<string, NotTakenGroup> = { [NOT_ASSIGNED]: 'not-assigned', [BACKBURNER]: 'backburner', [PR_READY]: 'pr-waiting', [PARTLY_DONE]: 'partly-done' };

/** What a person can do about an issue its labels keep out: take it off the backburner, or Won't do on a blocked one (issue #1891). */
const LABEL_ACTION: Record<string, IntakeOutcome['action']> = { [BACKBURNER]: 'unbackburner', [BLOCKED]: 'wont_do', [BLOCKED_STALE]: 'wont_do', [PR_CLOSED]: 'wont_do' };

const outcome = (i: GitHubIssue, reason?: string, action?: IntakeOutcome['action']): IntakeOutcome => ({
  key: i.url, title: i.title, repo: i.repo, ...(reason !== undefined ? { reason, group: GROUP_OF[reason] ?? 'other' } : {}), ...(action ? { action } : {}),
});

export async function discoverIssues(api: GitHubApi, config: DiscoverConfig, scope: DiscoverScope): Promise<DiscoverResult> {
  const { issues, repoErrors } = scope.listed;
  // The migration waits for a pass that lists every repo: a claim in a repo not read now is not judged.
  const migrated = scope.migrating === true && Object.keys(repoErrors).length === 0;
  const listed = new Map(issues.map((i) => [i.url, [...i.labels]]));
  const reasons = new Map<string, { reason: string; action?: IntakeOutcome['action'] }>();
  const candidates: GitHubIssue[] = [];
  for (const i of issues) {
    const ledger = scope.edited?.has(i.url) ? {} : ledgerReason(scope.item?.(i.url), { part: scope.part?.(i.url) ?? false, failureReported: scope.failureReported?.(i.url) ?? false, partsLeft: scope.partsLeft?.(i.url) ?? false, dropReported: scope.dropReported?.(i.url), doneReported: scope.doneReported?.(i.url) ?? false });
    const byLabel = labelReason(i, config.hopperName, ledger);
    if (byLabel) reasons.set(i.url, { reason: byLabel, ...(LABEL_ACTION[byLabel] ? { action: LABEL_ACTION[byLabel] } : {}) });
    else if (!isAssignedTo(i, scope.assignee)) reasons.set(i.url, { reason: NOT_ASSIGNED, action: 'assign' });
    else candidates.push(i);
  }
  const nominated = new Map<string, CommentCommand>();
  for (const i of issues.filter((x) => reasons.get(x.url)?.reason === NOT_ASSIGNED)) {
    const command = commandOf(await commentsOf(api, i), scope.assignee);
    if (command) { nominated.set(i.url, command); reasons.delete(i.url); candidates.push(i); }
  }

  // Claims are judged on the issues the hopper would take, and on those only not assigned to the user: a stale
  // claim there is released too, so assigning the issue later is enough. Such an issue keeps its reason.
  const judged = [...candidates, ...issues.filter((i) => reasons.get(i.url)?.reason === NOT_ASSIGNED)];
  const claimed = judged.filter((i) => i.labels.includes(LABEL_CLAIMED)).map((i) => i.url);
  const known = scope.knownKeys && claimed.length > 0 ? scope.knownKeys(claimed) : new Set<string>();
  const unheld = claimed.filter((url) => !known.has(url));
  const elsewhere = scope.othersKnown && unheld.length > 0 ? scope.othersKnown(unheld) : new Set<string>();
  const released: Released[] = [];
  for (const i of judged.filter((c) => unheld.includes(c.url))) {
    const taking = !reasons.has(i.url);
    const skip = (reason: string, action?: IntakeOutcome['action']) => { if (taking) reasons.set(i.url, { reason, ...(action ? { action } : {}) }); };
    if (!scope.knownKeys) { skip(CLAIMED_UNKNOWN); continue; }
    const v = claimVerdict(i, { ...scope, migrating: migrated }, elsewhere.has(i.url));
    if (v.kind === 'skip') { skip(v.reason, v.action); continue; }
    if (v.kind !== 'release') continue;
    try {
      // Only the claim labels it carries (issue #1154): a remove of one it lacks changes nothing.
      await api.removeLabels(i.repo, i.number, claimLabels(scope.holder).filter((l) => i.labels.includes(l)));
      i.labels = i.labels.filter((l) => l !== LABEL_CLAIMED && !l.startsWith(HOLDER_PREFIX));
      listed.set(i.url, [...i.labels]);
      released.push(v.released);
    } catch (err) {
      skip(`${CLAIMED_STALE}; releasing it failed: ${(err as Error).message}`);
    }
  }

  const open = issues.filter((i) => candidates.includes(i) && !reasons.has(i.url));
  const rejected = await stillRejected(api, open, scope, nominated);
  for (const url of rejected) reasons.set(url, { reason: REJECTED_BY_YOU });
  return {
    issues: open.filter((i) => !rejected.has(i.url)),
    repoErrors,
    outcomes: issues.map((i) => { const r = reasons.get(i.url); return outcome(i, r?.reason, r?.action); }),
    listed,
    seen: issues,
    released,
    migrated,
    nominated,
  };
}
