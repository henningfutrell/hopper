// Head branch deletion in the UI (issue #2914), pure: the note and each repository's state.
import type { HeadBranchSettings } from './wire.ts';

export const HEAD_BRANCHES_NOTE = 'With this on, the hopper deletes a pull request\'s branch after its merge. Once an hour it also deletes old branches of merged or closed pull requests. '
  + 'It never deletes the default, a protected or a release branch, a fork\'s branch, a branch with commits after its pull request ended, or a branch an open pull request still needs.';

/** A repository nobody named is on. */
export const headBranchesOn = (s: HeadBranchSettings, repo: string): boolean => s.repos[repo.toLowerCase()] ?? true;
