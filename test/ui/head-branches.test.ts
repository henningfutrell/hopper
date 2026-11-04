// Head branch deletion in the UI (issue #2914), pure: a repository nobody named is on.
import { describe, expect, it } from 'vitest';
import { HEAD_BRANCHES_NOTE, headBranchesOn } from '../../ui/src/model/head-branches.ts';

describe('head branches in Settings (issue #2914)', () => {
  it('a repository nobody named is on, and a saved setting is read in lower case', () => {
    expect(headBranchesOn({ repos: {} }, 'Owner/Repo')).toBe(true);
    expect(headBranchesOn({ repos: { 'owner/repo': false } }, 'Owner/Repo')).toBe(false);
  });
  it('the note says what it never deletes', () => {
    expect(HEAD_BRANCHES_NOTE).toMatch(/never deletes the default, a protected or a release branch/);
  });
});
