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
// The scope is given: a repo list (the app's installed repos, a connected account's chosen repos), listed repo
// by repo. Never a search: the app never passes an empty list, and a connected account's source with none
// chosen is paused (issue #321).

import type { IntakeOutcome } from '../../domain/intake.ts';
import type { Rejection } from '../../domain/rejection.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import {
  ADDRESS_PREFIX, HOLDER_PREFIX, LABEL_BACKBURNER, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY, LABEL_REJECTED, holderLabel,
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
  released: Released[];
  /** The intake migration ran in this pass: it was asked for and every repo was listed. */
  migrated: boolean;
}

type DiscoverConfig = Pick<GitHubSourceConfig, 'label' | 'hopperName'>;

export interface DiscoverScope {
  repos: string[];
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
}

async function fetchIssues(api: GitHubApi, config: DiscoverConfig, repos: string[]):
Promise<{ issues: GitHubIssue[]; repoErrors: Record<string, string> }> {
  if (repos.length === 0) return { issues: [], repoErrors: {} };
  const issues: GitHubIssue[] = [];
  const repoErrors: Record<string, string> = {};
  let firstError: unknown;
  for (const repo of repos) {
    try {
      issues.push(...(await api.listOpenIssues(repo, config.label)).map((i) => ({ ...i, repo })));
    } catch (err) {
      repoErrors[repo] = (err as Error).message;
      firstError ??= err;
    }
  }
  if (Object.keys(repoErrors).length === repos.length) throw firstError;
  return { issues, repoErrors };
}

/** GitHub logins compare without case. */
export const isAssignedTo = (i: Pick<GitHubIssue, 'assignees'>, login: string): boolean =>
  i.assignees.some((a) => a.toLowerCase() === login.toLowerCase());

/** Why the issue's labels keep it out, before assignment and claims are asked; undefined when they do not. */
export function labelReason(i: Pick<GitHubIssue, 'labels'>, name: string | null): string | undefined {
  if (i.labels.includes(LABEL_DONE)) return DONE_OPEN;
  if (i.labels.includes(LABEL_PR_READY)) return PR_READY;
  if (i.labels.includes(LABEL_PARTLY_DONE)) return PARTLY_DONE;
  if (i.labels.includes(LABEL_PR_CLOSED)) return PR_CLOSED;
  if (i.labels.includes(LABEL_FAILED)) return FAILED;
  if (i.labels.includes(LABEL_REJECTED)) return REJECTED_LABEL;
  if (i.labels.includes(LABEL_BACKBURNER)) return BACKBURNER;
  if (!forThisHopper(i, name)) return ADDRESSED_ELSEWHERE;
  return undefined;
}

/** An issue addressed to hoppers by name goes to those only; an unaddressed one to any. */
function forThisHopper(i: Pick<GitHubIssue, 'labels'>, name: string | null): boolean {
  const addressed = i.labels.filter((l) => l.startsWith(ADDRESS_PREFIX)).map((l) => l.slice(ADDRESS_PREFIX.length));
  return addressed.length === 0 || (name !== null && addressed.includes(name));
}

/** The rejected issues not assigned to the account again since their rejection. */
async function stillRejected(api: GitHubApi, issues: GitHubIssue[], scope: DiscoverScope): Promise<Set<string>> {
  const rejected = scope.rejections && issues.length > 0 ? scope.rejections(issues.map((i) => i.url)) : new Map<string, Rejection>();
  const skipped = new Set<string>();
  for (const i of issues) {
    const r = rejected.get(i.url);
    if (!r?.assignee) continue;
    const assigned = await api.assignedAt(i.repo, i.number, scope.assignee);
    if (assigned === undefined || Date.parse(assigned) <= Date.parse(r.at)) skipped.add(i.url);
  }
  return skipped;
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

const outcome = (i: GitHubIssue, reason?: string, action?: IntakeOutcome['action']): IntakeOutcome => ({
  key: i.url, title: i.title, repo: i.repo, ...(reason !== undefined ? { reason } : {}), ...(action ? { action } : {}),
});

export async function discoverIssues(api: GitHubApi, config: DiscoverConfig, scope: DiscoverScope): Promise<DiscoverResult> {
  const { issues, repoErrors } = await fetchIssues(api, config, scope.repos);
  // The migration waits for a pass that lists every repo: a claim in a repo not read now is not judged.
  const migrated = scope.migrating === true && Object.keys(repoErrors).length === 0;
  const listed = new Map(issues.map((i) => [i.url, [...i.labels]]));
  const reasons = new Map<string, { reason: string; action?: IntakeOutcome['action'] }>();
  const candidates: GitHubIssue[] = [];
  for (const i of issues) {
    const byLabel = labelReason(i, config.hopperName);
    if (byLabel) reasons.set(i.url, { reason: byLabel });
    else if (!isAssignedTo(i, scope.assignee)) reasons.set(i.url, { reason: NOT_ASSIGNED, action: 'assign' });
    else candidates.push(i);
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
      await api.removeLabels(i.repo, i.number, claimLabels(scope.holder));
      i.labels = i.labels.filter((l) => l !== LABEL_CLAIMED && !l.startsWith(HOLDER_PREFIX));
      listed.set(i.url, [...i.labels]);
      released.push(v.released);
    } catch (err) {
      skip(`${CLAIMED_STALE}; releasing it failed: ${(err as Error).message}`);
    }
  }

  const open = candidates.filter((i) => !reasons.has(i.url));
  const rejected = await stillRejected(api, open, scope);
  for (const url of rejected) reasons.set(url, { reason: REJECTED_BY_YOU });
  return {
    issues: open.filter((i) => !rejected.has(i.url)),
    repoErrors,
    outcomes: issues.map((i) => { const r = reasons.get(i.url); return outcome(i, r?.reason, r?.action); }),
    listed,
    released,
    migrated,
  };
}
