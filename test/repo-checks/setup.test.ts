// Issue #652 requirement 8: the repository setup the hopper checks, pure — what a guarded branch's protection gives from
// what GitHub showed of it, and the problems and the unread points of a repository's setup.
import { describe, expect, it } from 'vitest';
import { branchSetup, repoSetup, type BranchSetup, type RepoSetupFound } from '../../src/domain/types.ts';

describe('branchSetup', () => {
  const read = { branch: 'dev', protected: true, checks: ['pr / test'], rules: [] as string[] };

  it('takes the pull request and the force push rule from the branch protection when GitHub shows it', () => {
    expect(branchSetup({ ...read, protection: { pullRequest: true, forcePushes: false } }))
      .toEqual({ branch: 'dev', pullRequest: true, statusCheck: true, forcePushBlocked: true });
    expect(branchSetup({ ...read, protection: { pullRequest: false, forcePushes: true } }))
      .toEqual({ branch: 'dev', pullRequest: false, statusCheck: true, forcePushBlocked: false });
  });

  it('a ruleset is enough: its pull_request and non_fast_forward rules count without the branch protection', () => {
    expect(branchSetup({ ...read, rules: ['pull_request', 'non_fast_forward'] }))
      .toEqual({ branch: 'dev', pullRequest: true, statusCheck: true, forcePushBlocked: true });
  });

  it('a branch with no protection and no rule takes a direct push and a force push', () => {
    expect(branchSetup({ branch: 'beta', protected: false, checks: [], rules: [], protection: 'none' }))
      .toEqual({ branch: 'beta', pullRequest: false, statusCheck: false, forcePushBlocked: false });
  });

  it('a protected branch whose protection GitHub does not show is unread, not unprotected', () => {
    expect(branchSetup(read)).toEqual({ branch: 'dev', pullRequest: null, statusCheck: true, forcePushBlocked: null });
  });
});

describe('repoSetup', () => {
  const guarded = (branch: string, over: Partial<BranchSetup> = {}): BranchSetup => ({ branch, pullRequest: true, statusCheck: true, forcePushBlocked: true, ...over });
  const all: RepoSetupFound = { branches: [guarded('dev'), guarded('beta'), guarded('stable')], secretScanning: true, pushProtection: true };

  it('set up: every guarded branch needs a pull request and a status check and takes no force push, and secret scanning and push protection are on', () => {
    expect(repoSetup(all)).toEqual({ state: 'set up', problems: [], unread: [] });
  });

  it('not set up: says each problem, branch by branch', () => {
    const found: RepoSetupFound = {
      branches: [guarded('dev', { pullRequest: false }), guarded('beta', { pullRequest: false, statusCheck: false, forcePushBlocked: false }), guarded('stable', { forcePushBlocked: false })],
      secretScanning: false, pushProtection: false,
    };
    expect(repoSetup(found)).toEqual({
      state: 'not set up',
      problems: [
        'dev takes a push with no pull request',
        'beta takes a push with no pull request',
        'beta requires no status check',
        'beta allows force pushes',
        'stable allows force pushes',
        'secret scanning is off',
        'push protection is off',
      ],
      unread: [],
    });
  });

  it('unknown: no problem found, but GitHub did not show part of it', () => {
    const found: RepoSetupFound = { branches: [guarded('dev', { pullRequest: null, forcePushBlocked: null })], secretScanning: null, pushProtection: null };
    expect(repoSetup(found)).toEqual({
      state: 'unknown', problems: [],
      unread: ['whether dev needs a pull request', 'whether dev allows force pushes', 'whether secret scanning is on', 'whether push protection is on'],
    });
  });

  it('a problem makes it not set up, whatever is unread', () => {
    expect(repoSetup({ ...all, secretScanning: false, pushProtection: null }))
      .toEqual({ state: 'not set up', problems: ['secret scanning is off'], unread: ['whether push protection is on'] });
  });

  it('not read yet: unknown', () => {
    expect(repoSetup(undefined)).toEqual({ state: 'unknown', problems: [], unread: [] });
  });
});
