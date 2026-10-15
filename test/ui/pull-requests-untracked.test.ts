// @vitest-environment happy-dom
// The Pull requests view's Not tracked list (issue #1176): each open pull request of a job repository the hopper does not
// track, with why, in plain words; none, no list.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { untrackedText } from '../../ui/src/model/pull-requests.ts';
import type { UntrackedPullRequest } from '../../src/domain/types.ts';
import { boot, fixture, text, unmount } from './pull-requests-view-harness.ts';

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
      .toBe('closes #1114, which is not in Intake: take it into Intake, or give it the hopper label and assign it');
    expect(untrackedText(untracked[1]!)).toBe('part of #712, on dev, not on the landing branch');
    expect(untrackedText(untracked[2]!)).toBe('links no issue: no "Closes #N" or "Part of #N" in its text');
    expect(untrackedText(untracked[3]!)).toBe('closes #3, and no job of it made it or follows it; moved from dev to main');
  });

  it('a second pull request names the one its item\'s job follows', () => {
    expect(untrackedText(pr(1039, { issue: issue(712, true), reason: 'second_pull_request', followed: 'https://github.com/owner/a/pull/1200' })))
      .toBe('part of #712, whose job follows #1200: close one of them');
  });

  it('Take into Intake on one whose issue is not in Intake: for an operator, through its source', async () => {
    const untracked = [
      pr(1115, { source: 'github', issue: issue(1114), reason: 'issue_not_in_intake', offer: 'take_in' }),
      pr(20, { source: 'github', reason: 'no_issue' }),
    ];
    const daemon = await boot({ ...fixture, untracked });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="untracked"]')).not.toBeNull());
    const take = (n: number) => [...document.querySelectorAll(`[data-untracked$="/${n}"] button`)].find((b) => b.textContent?.includes('Take into Intake')) as HTMLButtonElement | undefined;
    expect(take(20)).toBeUndefined();
    await act(async () => { take(1115)!.click(); });
    await vi.waitFor(() => expect(daemon.bodies).toEqual([{ path: '/ui/api/sources/github/intake', body: { kind: 'take_in', keys: ['https://github.com/owner/a/issues/1114'] } }]));
  });

  it('a viewer: no Take into Intake', async () => {
    await boot({ ...fixture, untracked: [pr(1115, { source: 'github', issue: issue(1114), reason: 'issue_not_in_intake', offer: 'take_in' })] }, 'viewer');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="untracked"]')).not.toBeNull());
    expect(document.querySelector('[data-untracked] button')).toBeNull();
  });

  it('none: no list', async () => {
    await boot(fixture);
    expect(document.querySelector('[data-slot="untracked"]')).toBeNull();
  });

  it('Take into Intake answers before its GitHub write (issue #1194): the row says so from the click on, and a failure says why', async () => {
    const offered = pr(1115, { source: 'github', issue: issue(1114), reason: 'issue_not_in_intake', offer: 'take_in' });
    const daemon = await boot({ ...fixture, untracked: [offered] });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="untracked"]')).not.toBeNull());
    const row = () => document.querySelector('[data-untracked$="/1115"]')!;
    const take = () => [...row().querySelectorAll('button')].find((b) => b.textContent?.includes('Take into Intake'));
    await act(async () => { take()!.click(); });
    expect(row().querySelector('[data-write-behind="running"]')?.textContent).toContain('taking into Intake on GitHub');
    expect(take()).toBeUndefined();
    await vi.waitFor(() => expect(daemon.bodies).toHaveLength(1));
    await unmount();
    await boot({ ...fixture, untracked: [{ ...offered, writeBehind: { act: 'take_in', state: 'failed', error: 'label refused' } }] });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="untracked"]')).not.toBeNull());
    expect(row().querySelector('[data-write-behind="failed"]')?.textContent).toContain('label refused');
    expect(take()).toBeDefined();
    await unmount();
    await boot({ ...fixture, untracked: [{ ...offered, writeBehind: { act: 'take_in', state: 'running' } }] });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="untracked"]')).not.toBeNull());
    expect(row().querySelector('[data-write-behind="running"]')).not.toBeNull();
    expect(take()).toBeUndefined();
  });
});
