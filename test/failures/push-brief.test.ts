// The push brief (issue #1806): a job told to push its kept work pushes to any repository its user can push to, with a
// pull request there; it names the work that stays only when the hopper refuses the push.
import { describe, expect, it } from 'vitest';
import { pushBrief } from '../../src/failures/kept-work.ts';

describe('the push brief', () => {
  it('says a push goes to a new branch of any repository the user can push to, not only the job\'s own', () => {
    const brief = pushBrief(undefined, true);
    expect(brief).toContain('A push goes to a new branch of any repository your user can push to, never to its default or a release branch (only with direct push on for the repository, straight to its target branch, as a fast-forward).');
    expect(brief).toContain('Work in a clone of another repository is pushed to that repository, with a pull request there.');
    expect(brief).not.toContain('only to a branch of this job\'s own repository');
  });
});
