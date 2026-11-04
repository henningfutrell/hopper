// Head branch deletion (issue #2914, design.md "Head branch deletion"): after a merge the hopper deletes the pull request's
// head branch, and a sweep finds the stale ones nothing deleted. On by default, per repository. Pure: the setting, why a head
// branch is kept, and which branches of a listing are stale. The GitHub calls are src/sources/github/head-branches.ts.
import { RELEASE_BRANCHES } from './landing-batches.ts';

/** Per repository, `owner/repo` lowercased: on or off. A repository not named is on. */
export interface HeadBranchSettings { repos: Record<string, boolean> }

export const DEFAULT_HEAD_BRANCHES: HeadBranchSettings = { repos: {} };

/** A change: each repository named set on or off, or `null` to be on by default again. */
export interface HeadBranchPatch { repos: Record<string, boolean | null> }

/** As GET /api/head-branches answers it: the settings, and the job repositories the UI offers. */
export interface HeadBranchView extends HeadBranchSettings { choices: { repos: string[] } }

const key = (repo: string): string => repo.toLowerCase();

export const headBranchDeletionOn = (s: HeadBranchSettings, repo: string): boolean => s.repos[key(repo)] ?? true;

export function patchHeadBranches(s: HeadBranchSettings, p: HeadBranchPatch): HeadBranchSettings {
  const repos = { ...s.repos };
  for (const [repo, on] of Object.entries(p.repos)) {
    if (on === null) delete repos[key(repo)];
    else repos[key(repo)] = on;
  }
  return { repos };
}

/** How long after its pull request ended the sweep leaves a branch: a person may reopen a closed one, and the merge's own row goes first. */
export const HEAD_BRANCH_GRACE_MS = 24 * 60 * 60_000;
/** How often a source's sweep runs, at most. */
export const HEAD_BRANCH_SWEEP_EVERY_MS = 60 * 60_000;
/** The most rows one sweep keeps: each row costs a few GitHub calls, and the next sweep takes the rest. */
export const HEAD_BRANCH_SWEEP_ROWS = 100;

/** The pull request as a deletion reads it. A closed or merged pull request's head stays at the commit it ended on. */
export interface HeadBranchPull {
  url: string;
  state: 'open' | 'closed' | 'merged';
  headRef: string;
  headOid: string;
  /** Its head is in another repository: the branch is not this repository's to delete. */
  fork: boolean;
  defaultBranch: string;
  /** When it merged or closed. */
  endedAt?: string;
}

/** The branch as a deletion reads it. */
export interface BranchFacts {
  tip: string;
  protected: boolean;
  /** Open pull requests of this repository with this branch as their head. */
  openHeads: number;
  /** Open pull requests with this branch as their base: GitHub closes them when the branch goes. */
  openBases: number;
}

const RELEASE_LINE = /^releases?[-/]/i;

const longLivedName = (name: string, defaultBranch: string, keep: readonly string[]): 'default' | 'release' | 'long-lived' | undefined => {
  const lower = name.toLowerCase();
  if (lower === defaultBranch.toLowerCase()) return 'default';
  if (RELEASE_BRANCHES.includes(lower) || RELEASE_LINE.test(name)) return 'release';
  return keep.some((k) => k.toLowerCase() === lower) ? 'long-lived' : undefined;
};

/** Why pull request `pr`'s head branch is kept, from the pull request alone. `keep`: the repository's landing and tested branches. */
export const pullBranchKept = (pr: HeadBranchPull, keep: readonly string[]): string | undefined => {
  if (pr.state === 'open') return 'open';
  if (pr.fork) return 'fork';
  return longLivedName(pr.headRef, pr.defaultBranch, keep);
};

/** Why pull request `pr`'s head branch is kept, from the branch as just read. */
export const headBranchKept = (pr: Pick<HeadBranchPull, 'headOid'>, b: BranchFacts): string | undefined => {
  if (b.protected) return 'protected';
  if (b.tip !== pr.headOid) return 'moved';
  if (b.openHeads > 0) return 'open-head';
  return b.openBases > 0 ? 'open-base' : undefined;
};

/** One branch of a listing, with the pull requests whose head it is. */
export interface BranchRef {
  name: string;
  tip: string;
  pulls: { url: string; state: 'open' | 'closed' | 'merged'; headOid: string; fork: boolean; endedAt?: string }[];
}

export interface StaleHeadBranch { branch: string; pullRequest: string; head: string }

/**
 * The stale branches of a listing: no open pull request of this repository has it as its head, and one that ended at least
 * the grace ago ended on the commit it is at now. A branch with commits after that, or that no pull request names, is no one's
 * to delete.
 */
export function staleHeadBranches(refs: readonly BranchRef[], o: { now: number; defaultBranch: string; keep: readonly string[] }): StaleHeadBranch[] {
  return refs.flatMap((r) => {
    if (longLivedName(r.name, o.defaultBranch, o.keep)) return [];
    const own = r.pulls.filter((p) => !p.fork);
    if (own.some((p) => p.state === 'open')) return [];
    const at = own.find((p) => p.headOid === r.tip && p.endedAt !== undefined && Date.parse(p.endedAt) + HEAD_BRANCH_GRACE_MS <= o.now);
    return at ? [{ branch: r.name, pullRequest: at.url, head: r.tip }] : [];
  });
}
