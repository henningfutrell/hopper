// @vitest-environment happy-dom
// The Pull requests view's Not tracked list (issue #1176): each open pull request of a job repository the hopper does not
// track, with why, in plain words; none, no list.
import { describe, expect, it, vi } from 'vitest';
import { untrackedText } from '../../ui/src/model/pull-requests.ts';
import type { UntrackedPullRequest } from '../../src/domain/types.ts';
import { boot, fixture, text } from './pull-requests-view-harness.ts';

const pr = (n: number, over: Partial<UntrackedPullRequest>): UntrackedPullRequest =>
  ({ repo: 'owner/a', url: `https://github.com/owner/a/pull/${n}`, base: 'main', reason: 'not_by_a_job', ...over });
const issue = (n: number, part = false) => ({ number: n, url: `https://github.com/owner/a/issues/${n}`, part });

describe('Pull requests view: not tracked (issue #1176)', () => {
  it('an open pull request the hopper does not track is listed with why', async () => {
    const untracked = [
      pr(1115, { title: 'Run the affected tests in shards', issue: issue(1114), reason: 'issue_not_in_intake' }),
      pr(1039, { issue: issue(712, true), base: 'dev', reason: 'wrong_base' }),
      pr(20, { reason: 'no_issue' }),
      pr(21, { issue: issue(3), retargeted: { from: 'dev', to: 'main' } }),
    ];
    await boot({ ...fixture, untracked });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="untracked"]')).not.toBeNull());
    expect([...document.querySelectorAll('[data-untracked]')].map((e) => e.getAttribute('data-untracked')))
      .toEqual(untracked.map((u) => u.url));
    expect(text('[data-slot="untracked-reason"]', document.querySelector('[data-untracked$="/1115"]')!))
      .toBe('closes #1114, which is not in Intake: give the issue the hopper label and assign it');
    expect(untrackedText(untracked[1]!)).toBe('part of #712, on dev, not on the landing branch');
    expect(untrackedText(untracked[2]!)).toBe('links no issue: no "Closes #N" or "Part of #N" in its text');
    expect(untrackedText(untracked[3]!)).toBe('closes #3, and no job of it made it or follows it; moved from dev to main');
  });

  it('none: no list', async () => {
    await boot(fixture);
    expect(document.querySelector('[data-slot="untracked"]')).toBeNull();
  });
});
