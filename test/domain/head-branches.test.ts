// Head branch deletion (issue #2914), pure: the setting, on by default per repository; why a pull request's head branch is
// kept; and which branches of a listing the sweep finds stale.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAD_BRANCHES, HEAD_BRANCH_GRACE_MS, headBranchDeletionOn, headBranchKept, patchHeadBranches, pullBranchKept, staleHeadBranches,
  type BranchFacts, type BranchRef, type HeadBranchPull,
} from '../../src/domain/head-branches.ts';

const pull: HeadBranchPull = { url: 'https://github.com/o/r/pull/1', state: 'merged', headRef: 'hopper/1-fix', headOid: 'aaa', fork: false, defaultBranch: 'main', endedAt: '2026-11-01T00:00:00.000Z' };
const branch: BranchFacts = { tip: 'aaa', protected: false, openHeads: 0, openBases: 0 };

describe('the setting', () => {
  it('is on for a repository nobody named, and a person sets it per repository, in any case', () => {
    expect(headBranchDeletionOn(DEFAULT_HEAD_BRANCHES, 'O/R')).toBe(true);
    const off = patchHeadBranches(DEFAULT_HEAD_BRANCHES, { repos: { 'O/R': false } });
    expect(off).toEqual({ repos: { 'o/r': false } });
    expect(headBranchDeletionOn(off, 'o/r')).toBe(false);
    expect(headBranchDeletionOn(off, 'o/other')).toBe(true);
    expect(patchHeadBranches(off, { repos: { 'o/r': null } })).toEqual({ repos: {} });
  });
});

describe('why a head branch is kept', () => {
  it('nothing keeps a merged job branch whose tip is the head', () => {
    expect(pullBranchKept(pull, [])).toBeUndefined();
    expect(headBranchKept(pull, branch)).toBeUndefined();
  });
  it('an open pull request, a fork, the default branch, a release branch and a branch the repository names are kept', () => {
    expect(pullBranchKept({ ...pull, state: 'open' }, [])).toBe('open');
    expect(pullBranchKept({ ...pull, fork: true }, [])).toBe('fork');
    expect(pullBranchKept({ ...pull, headRef: 'main' }, [])).toBe('default');
    expect(pullBranchKept({ ...pull, headRef: 'trunk', defaultBranch: 'trunk' }, [])).toBe('default');
    for (const r of ['dev', 'Stable', 'canary', 'beta', 'master', 'release/1.2', 'releases/2', 'release-3']) expect(pullBranchKept({ ...pull, headRef: r }, [])).toBe('release');
    expect(pullBranchKept({ ...pull, headRef: 'landing' }, ['landing'])).toBe('long-lived');
  });
  it('a protected branch, a tip past the head, and a branch another open pull request needs are kept', () => {
    expect(headBranchKept(pull, { ...branch, protected: true })).toBe('protected');
    expect(headBranchKept(pull, { ...branch, tip: 'bbb' })).toBe('moved');
    expect(headBranchKept(pull, { ...branch, openHeads: 1 })).toBe('open-head');
    expect(headBranchKept(pull, { ...branch, openBases: 1 })).toBe('open-base');
  });
});

describe('the stale branches of a listing', () => {
  const now = Date.parse(pull.endedAt!) + HEAD_BRANCH_GRACE_MS;
  const ref = (name: string, pulls: BranchRef['pulls'], tip = 'aaa'): BranchRef => ({ name, tip, pulls });
  const ended = { url: pull.url, state: 'merged' as const, headOid: 'aaa', fork: false, endedAt: pull.endedAt! };
  const stale = (refs: BranchRef[], keep: string[] = []) => staleHeadBranches(refs, { now, defaultBranch: 'main', keep });

  it('a branch at the head of a merged or closed pull request, past the grace', () => {
    expect(stale([ref('a', [ended]), ref('b', [{ ...ended, url: `${pull.url}0`, state: 'closed' }])])).toEqual([
      { branch: 'a', pullRequest: pull.url, head: 'aaa' }, { branch: 'b', pullRequest: `${pull.url}0`, head: 'aaa' },
    ]);
  });
  it('not a branch with commits after its pull request ended, or one no pull request names', () => {
    expect(stale([ref('a', [ended], 'bbb'), ref('b', [])])).toEqual([]);
  });
  it('not a branch with an open pull request, even with an older ended one at its tip', () => {
    expect(stale([ref('a', [ended, { ...ended, url: `${pull.url}0`, state: 'open' }])])).toEqual([]);
  });
  it('not within the grace, not a fork\'s pull request, not a default, release or named branch', () => {
    expect(stale([ref('a', [{ ...ended, endedAt: new Date(now - 1000).toISOString() }])])).toEqual([]);
    expect(stale([ref('a', [{ ...ended, fork: true }])])).toEqual([]);
    expect(stale(['main', 'dev', 'release/1', 'landing'].map((n) => ref(n, [ended])), ['landing'])).toEqual([]);
  });
  it('a fork\'s open pull request of the same name does not hold the branch', () => {
    expect(stale([ref('a', [ended, { ...ended, url: `${pull.url}0`, state: 'open', fork: true }])])).toHaveLength(1);
  });
});
