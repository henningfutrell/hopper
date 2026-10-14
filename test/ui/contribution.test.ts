// Contribution in the UI (issue #429), pure: what the panel says is on now, and what it allows.
import { describe, expect, it } from 'vitest';
import { CONTRIBUTION_NOTE, contributionSummary } from '../../ui/src/model/contribution.ts';

describe('the Contribution panel', () => {
  it('says whether jobs may work through a fork', () => {
    expect(contributionSummary({ on: false })).toBe('Off: a job of a repository your user cannot push to gets no fork, and its push is refused.');
    expect(contributionSummary({ on: true })).toBe('On: a job of a repository your user cannot push to forks it into your account and opens its pull request there from the fork.');
  });

  it('the note says what goes out under the user\'s account', () => {
    expect(CONTRIBUTION_NOTE).toContain('under your GitHub account');
    expect(CONTRIBUTION_NOTE).toContain('contributing rules');
  });
});
