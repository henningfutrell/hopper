// @vitest-environment happy-dom
// The Pull requests view (issue #637), rendered inside the whole app against a fake of the daemon's HTTP surface: the
// header says how many repositories have yolo mode on, where merging waits, and how many have merge conflicts (issue #897);
// one group per repository, with its yolo badge and a link to yolo mode's one switch in Settings (issue #897); each card with its state badge and its repository's yolo badge. A repository with no
// checks (issue #677) is flagged in the header and its group, with the job that adds them: Queue job and Dismiss.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { checksText, doingText, landingText, noChecksLine, waitsText, waitingLine, yoloLine } from '../../ui/src/model/pull-requests.ts';
import type { LandingCard, PullRequestsView, RepoChecksView } from '../../src/domain/types.ts';
import { card, fixture, repoChecks, noChecks, checksFixture, boot, text, cardOf, unmount } from './pull-requests-view-harness.ts';

describe('Pull requests view', () => {
  it('the nav has a Pull requests entry', async () => {
    await boot(fixture);
    expect(text('aside nav a[href="#pull-requests"]')).toBe('Pull requests');
  });

  it('the header says how many repos have yolo mode on and where merging waits', async () => {
    await boot(fixture);
    expect(text('[data-slot="pr-yolo-line"]')).toBe('yolo: on for 2 of 3 repos');
    expect(text('[data-slot="pr-waiting-line"]')).toBe('merging waits: 2 PRs in owner/a (waiting for a person to merge), 1 PR in org/b (waiting for checks)');
    expect(waitingLine({ ...fixture, waiting: [] })).toBe('merging waits: nothing');
    expect(yoloLine(fixture)).toBe('yolo: on for 2 of 3 repos');
  });

  it('one group per repo, in order, each with its yolo badge and note', async () => {
    await boot(fixture);
    const groups = [...document.querySelectorAll('[data-repo]')];
    expect(groups.map((g) => g.getAttribute('data-repo'))).toEqual(['owner/a', 'org/b', 'org/c']);
    expect(groups[0]!.textContent).toContain('yolo off');
    expect(text('[data-slot="yolo-note"]', groups[0]!)).toContain('waits for a person');
    expect(text('[data-slot="yolo-note"]', groups[1]!)).toContain('merges a ready pull request');
  });

  it('each card shows its state badge, its yolo badge, the PR, the issue, checks and merge state', async () => {
    await boot(fixture);
    expect(text('[data-slot="pr-state"]', cardOf('j1'))).toBe('open');
    expect(text('[data-slot="pr-yolo"]', cardOf('j1'))).toBe('yolo off');
    expect(text('[data-slot="pr-state"]', cardOf('j3'))).toBe('open');
    expect(text('[data-slot="pr-yolo"]', cardOf('j3'))).toBe('yolo on');
    expect(text('[data-slot="pr-state"]', cardOf('j4'))).toBe('closed');
    expect(text('[data-slot="pr-yolo"]', cardOf('j4'))).toBe('yolo on');
    const pr = cardOf('j1').querySelector('a[href="https://github.com/owner/a/pull/11"]')!;
    expect(pr.textContent).toBe('#11');
    expect(cardOf('j1').querySelector('a[href="https://github.com/owner/a/issues/10"]')!.textContent).toBe('closes #10');
    expect(cardOf('j1').textContent).toContain('checks pass');
    expect(cardOf('j1').textContent).toContain('mergeable');
    expect(text('[data-slot="pr-waits"]', cardOf('j1'))).toBe('waiting for a person to merge');
    expect(text('[data-slot="pr-waits"]', cardOf('j3'))).toBe('waiting for checks');
    expect(cardOf('j2').textContent).toContain('pull request not found yet');
    expect(cardOf('j2').textContent).toContain('part of #10');
    expect(cardOf('j3').textContent).toContain('checks pending');
    expect(cardOf('j4').textContent).toContain('merge conflicts');
    expect(text('[data-slot="pr-merge-error"]', cardOf('j4'))).toContain('Base branch was modified');
  });

  it('a direct job\'s card (issue #1068) links its direct job, not an issue, and has no Merge now or Close PR', async () => {
    const { issue: _i, ...noIssue } = card({ jobId: 'd1', directJob: { url: 'https://hopper.test/#direct-jobs/x1' } });
    await boot({ ...fixture, repos: [{ repo: 'owner/a', yolo: false, pullRequests: [noIssue, card({})] }] });
    expect(cardOf('d1').querySelector('a[href="https://hopper.test/#direct-jobs/x1"]')!.textContent).toBe('direct job');
    expect(cardOf('d1').querySelector('[data-slot="pr-actions"]')).toBeNull();
    expect(cardOf('j1').querySelector('[data-slot="pr-actions"]')).not.toBeNull();
  });

  it('why a card waits, in plain words (issue #677)', () => {
    expect(waitsText(card({ waits: 'conflicts', base: 'dev' }))).toBe('conflicts with dev');
    expect(waitsText(card({ waits: 'conflicts' }))).toBe('conflicts with its base branch');
    expect(waitsText(card({ waits: 'ready' }))).toBe('ready, merging');
    expect(waitsText(card({ waits: 'merge held' }))).toBe('ready, waits for another pull request to merge first');
    expect(waitsText(card({ waits: 'needs merge', repo: 'zed/tool' }))).toBe('needs merge in zed/tool');
    expect(waitsText(card({ waits: 'checks not started' }))).toBe('waiting for checks to start');
    expect(waitsText(card({ waits: 'checks failing' }))).toBe('checks failed');
    expect(waitsText(card({ waits: 'checks unknown', checksWhy: 'the GitHub App lacks Checks: read' }))).toBe('checks unknown: the GitHub App lacks Checks: read');
    expect(waitsText(card({ waits: 'checks unknown' }))).toBe('the hopper cannot read its checks');
    expect(waitsText(card({ waits: 'no pull request' }))).toBe('no pull request found yet');
    expect(waitsText(card({ waits: 'not checked yet' }))).toBe('not checked yet');
  });

  it('what the hopper does about a card that needs tending, in plain words (issue #927)', () => {
    expect(doingText(card({ waits: 'conflicts', base: 'dev', queue: { next: true } }))).toBe('the hopper rebases it onto dev on its next sync');
    expect(doingText(card({ waits: 'conflicts', queue: { next: true } }))).toBe('the hopper rebases it onto its base branch on its next sync');
    expect(doingText(card({ waits: 'checks failing', queue: { next: true } }))).toBe('the hopper fixes its failed checks on its next sync');
    expect(doingText(card({ waits: 'conflicts', queue: { refused: 'its issue is not assigned to the connected account' } })))
      .toBe('the hopper cannot tend it: its issue is not assigned to the connected account');
    expect(doingText(card({ waits: 'checks failing', queue: { held: { pullRequest: 904, why: 'merging' } } }))).toBe('held behind #904, which the hopper merges first: they conflict');
    expect(doingText(card({ waits: 'conflicts', queue: { held: { pullRequest: 904, why: 'tending' } } }))).toBe('held behind #904, which a job works on now: they conflict');
    // Issue #1162: the hold's age, and the state of the tend job that holds it.
    const now = Date.parse('2026-10-14T12:00:00.000Z');
    expect(doingText(card({ waits: 'conflicts', queue: { held: { pullRequest: 904, why: 'tending', since: '2026-10-14T11:35:00.000Z', holder: { jobId: 'abcdef0123', status: 'waiting_on' } } } }), now))
      .toBe('held behind #904 since 25m ago, which job abcdef01 works on now (waiting on): they conflict');
    expect(doingText(card({ waits: 'checks failing', gaveUp: 'checks still fail after 3 fixes: a person must look at them' }))).toBe('the hopper gave up: checks still fail after 3 fixes: a person must look at them');
    expect(doingText(card({ state: 'closed', waits: undefined }))).toBe('');
  });

  it('a pull request with merge conflicts: its checks wait for the rebase, never "pending" (issue #938)', () => {
    expect(checksText(card({ checks: 'pending', mergeable: 'conflicts' }))).toBe('checks run after the rebase');
    expect(checksText(card({ checks: 'failing', mergeable: 'conflicts' }))).toBe('checks fail');
    expect(checksText(card({ checks: 'pending', mergeable: 'mergeable' }))).toBe('checks pending');
  });

  it('what the hopper does about every open card, in plain words (issue #927)', () => {
    const job = 'abcdef0123456789';
    expect(doingText(card({ waits: 'tending', tendJobId: job, tendStep: 'rebase', base: 'dev' }))).toBe('the hopper rebases it onto dev: job abcdef01 works on it now');
    expect(doingText(card({ waits: 'tending', tendJobId: job, tendStep: 'rebase' }))).toBe('the hopper rebases it onto its base branch: job abcdef01 works on it now');
    expect(doingText(card({ waits: 'tending', tendJobId: job, tendStep: 'fix_checks' }))).toBe('the hopper fixes its failed checks: job abcdef01 works on it now');
    expect(doingText(card({ waits: 'tending', tendJobId: job, tendStep: 'rebase', base: 'dev', tendWaits: 'all 2 lanes of the machine are busy' })))
      .toBe('the hopper rebases it onto dev: job abcdef01 waits to start: all 2 lanes of the machine are busy');
    expect(doingText(card({ waits: 'checks pending', yolo: true }))).toBe('the hopper merges it when its checks pass');
    expect(doingText(card({ waits: 'checks not started', yolo: true }))).toBe('the hopper merges it when its checks pass, or when no check starts within 2 minutes of its last push');
    expect(doingText(card({ waits: 'ready', yolo: true }))).toBe('the hopper merges it on its next sync');
    expect(doingText(card({ waits: 'not checked yet', yolo: true }))).toBe('the hopper reads it from GitHub on its next sync');
    expect(doingText(card({ waits: 'no pull request' }))).toBe('the hopper looks for its pull request on each sync');
    expect(doingText(card({ waits: 'merge refused', yolo: true }))).toBe('the hopper tries the merge again on each sync');
    expect(doingText(card({ waits: 'checks unknown', yolo: true }))).toBe('nothing: the hopper may not read its checks, so a person merges it');
    expect(doingText(card({ waits: 'yolo off' }))).toBe('nothing: yolo mode is off, so a person merges it');
    expect(doingText(card({ waits: 'needs merge' })))
      .toBe('nothing: the hopper merges in a repository that is not a job repository only when a person names it on in Settings → Yolo mode, so a person merges it there');
    expect(doingText(card({ waits: 'draft' }))).toBe('nothing: the hopper does not tend a draft, so a person marks it ready');
  });

  it('yolo mode has one switch, in Settings: each group links to it and turns nothing itself (issue #897)', async () => {
    const daemon = await boot(fixture);
    expect(document.querySelector('[data-repo] [role="switch"]')).toBeNull();
    const link = document.querySelector('[data-repo="owner/a"] a[data-slot="yolo-settings"]')!;
    expect(link.getAttribute('href')).toBe('#settings/yolo-mode');
    expect(daemon.bodies).toEqual([]);
  });

  it('the header counts the pull requests with merge conflicts (issue #897)', async () => {
    const conflicted = { ...fixture, repos: [{ ...fixture.repos[0]!, pullRequests: [card({ mergeable: 'conflicts', waits: 'conflicts' })] }] };
    await boot(conflicted);
    expect(text('[data-slot="pr-conflicts-line"]')).toBe('1 pull request has merge conflicts: fix it, or close it');
    await unmount();
    await boot(fixture);
    expect(document.querySelector('[data-slot="pr-conflicts-line"]')).toBeNull();
  });

  it('an open card has Merge now and Close PR, each asks once, then posts the job (issue #677)', async () => {
    const daemon = await boot(fixture);
    const buttonIn = (el: ParentNode, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
    const dialog = () => vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(buttonIn(cardOf('j4'), 'Merge now')).toBeUndefined();
    expect(buttonIn(cardOf('j2'), 'Merge now')).toBeUndefined();
    await act(async () => { buttonIn(cardOf('j1'), 'Merge now')!.click(); });
    expect((await dialog()).textContent).toContain('Merge #11 into its base branch now?');
    expect(daemon.bodies).toEqual([]);
    await act(async () => { buttonIn(await dialog(), 'Merge')!.click(); });
    await vi.waitFor(() => expect(daemon.bodies).toEqual([{ path: '/ui/api/pull-requests/merge', body: { jobId: 'j1' } }]));
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    await act(async () => { buttonIn(cardOf('j3'), 'Close PR')!.click(); });
    expect((await dialog()).textContent).toContain('Close #11 without a merge?');
    await act(async () => { buttonIn(await dialog(), 'Close PR')!.click(); });
    await vi.waitFor(() => expect(daemon.bodies[1]).toEqual({ path: '/ui/api/pull-requests/close', body: { jobId: 'j3' } }));
  });

  it('a card the hopper gave up on has one action, Tend again, which posts the job at once (issue #1010); a viewer is not offered it', async () => {
    const gaveUp = card({ jobId: 'j5', waits: 'tend failed', tendJobId: 't5', tendStep: 'rebase', gaveUp: 'the job that rebased it failed: Design-level conflict.' });
    const view: PullRequestsView = { ...fixture, repos: [{ repo: 'owner/a', yolo: false, pullRequests: [gaveUp] }] };
    const daemon = await boot(view);
    // Its one action; Show diff (issue #1169) is a read.
    expect([...cardOf('j5').querySelectorAll('button:not([data-slot="pr-diff-toggle"])')].map((b) => b.textContent)).toEqual(['Tend again']);
    expect(text('[data-slot="pr-tend-again"]', cardOf('j5'))).toContain('Tend again');
    await act(async () => { (cardOf('j5').querySelector('[data-slot="pr-tend-again"] button') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(daemon.bodies).toEqual([{ path: '/ui/api/pull-requests/tend', body: { jobId: 'j5' } }]));
    // Answered before the tend (issue #1194): the button waits until the stream says how it ended.
    await vi.waitFor(() => expect(text('[data-slot="pr-tend-again"]', cardOf('j5'))).toContain('Tending again'));
    await unmount();
    await boot(view, 'viewer');
    expect([...cardOf('j5').querySelectorAll('button')]).toEqual([]);
  });

  it('a viewer sees no Merge now or Close PR', async () => {
    await boot(fixture, 'viewer');
    expect([...cardOf('j1').querySelectorAll('button')].map((b) => b.textContent)).toEqual([]);
  });

  it('an operator sends an open pull request back for rework with notes (issue #724); no notes, no send', async () => {
    const daemon = await boot(fixture);
    const rework = () => cardOf('j1').querySelector<HTMLButtonElement>('[data-slot="pr-rework"]')!;
    // Only an open card with its pull request found offers it.
    expect(cardOf('j2').querySelector('[data-slot="pr-rework"]')).toBeNull();
    expect(cardOf('j4').querySelector('[data-slot="pr-rework"]')).toBeNull();
    await act(async () => { rework().click(); });
    const notes = cardOf('j1').querySelector<HTMLTextAreaElement>('[data-slot="pr-rework-notes"]')!;
    const send = () => cardOf('j1').querySelector<HTMLButtonElement>('[data-slot="pr-rework-send"]')!;
    expect(send().disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, '  Rename the flag.  ');
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(send().disabled).toBe(false);
    await act(async () => { send().click(); });
    await vi.waitFor(() => expect(daemon.bodies).toEqual([{ path: '/ui/api/jobs/j1/rework', body: { notes: 'Rename the flag.' } }]));
  });

  it('a viewer is not offered rework', async () => {
    await boot(fixture, 'viewer');
    expect(cardOf('j1').querySelector('[data-slot="pr-rework"]')).toBeNull();
  });

  it('a repository whose checks no read gets: its group says it once, with the fix, and each card says why (issue #1244)', async () => {
    const why = 'the GitHub App lacks Checks: read: add them to the GitHub App and accept them on its installation';
    const unread = card({ jobId: 'j5', repo: 'org/b', yolo: true, checks: 'unknown', waits: 'checks unknown', checksWhy: why });
    await boot({ ...fixture, repos: fixture.repos.map((r) => r.repo === 'org/b' ? { ...r, pullRequests: [...r.pullRequests, unread] } : r),
      checksProblems: [{ repo: 'org/b', why, pullRequests: [11] }] });
    const group = (repo: string) => document.querySelector(`[data-repo="${repo}"]`)!;
    expect(group('owner/a').querySelector('[data-slot="repo-checks-unread"]')).toBeNull();
    expect(group('org/b').querySelectorAll('[data-slot="repo-checks-unread"]')).toHaveLength(1);
    expect(text('[data-slot="repo-checks-unread"]', group('org/b'))).toBe(`The hopper cannot read the checks of #11, so it does not merge it: ${why}`);
    expect(text('[data-slot="pr-waits"]', cardOf('j5'))).toBe(`checks unknown: ${why}`);
  });

  it('a repository with no checks is flagged in the header and in its group (issue #677)', async () => {
    await boot(fixture, 'admin', checksFixture);
    await vi.waitFor(() => expect(text('[data-slot="pr-no-checks-line"]')).toBe('no checks: org/b, org/c (yolo merges unverified code there)'));
    const group = (repo: string) => document.querySelector(`[data-repo="${repo}"]`)!;
    expect(group('owner/a').querySelector('[data-slot="repo-no-checks"]')).toBeNull();
    expect(text('[data-slot="repo-no-checks"]', group('org/b'))).toContain('No checks: yolo mode merges unverified code here.');
    expect(noChecksLine({ repos: [repoChecks('a/b', { state: 'no checks' })] })).toBe('no checks: a/b');
    expect(noChecksLine(checksFixture.repos[0] ? { repos: [checksFixture.repos[0]] } : { repos: [] })).toBe('');
    expect(noChecksLine({} as RepoChecksView)).toBe('');
  });

  it('Queue job posts the repository at once; a queued job shows its issue; Dismiss posts the repository (issue #677)', async () => {
    const daemon = await boot(fixture, 'admin', checksFixture);
    const group = (repo: string) => document.querySelector(`[data-repo="${repo}"]`)!;
    const buttonIn = (el: ParentNode, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
    await vi.waitFor(() => expect(group('org/b').querySelector('[data-slot="repo-checks-job"]')).not.toBeNull());
    expect(text('[data-slot="repo-checks-job"]', group('org/b'))).toContain('Add PR checks to org/b');
    await act(async () => { buttonIn(group('org/b'), 'Queue job')!.click(); });
    await vi.waitFor(() => expect(daemon.bodies).toEqual([{ path: '/ui/api/repo-checks/queue', body: { repo: 'org/b' } }]));
    expect(buttonIn(group('org/c'), 'Queue job')).toBeUndefined();
    expect(group('org/c').querySelector('a[href="https://github.com/org/c/issues/7"]')!.textContent).toContain('#7');
    await act(async () => { buttonIn(group('org/c'), 'Dismiss')!.click(); });
    await vi.waitFor(() => expect(daemon.bodies[1]).toEqual({ path: '/ui/api/repo-checks/dismiss', body: { repo: 'org/c', dismissed: true } }));
  });

  it('a dismissed recommendation keeps the warning; a viewer sees the warning and no buttons (issue #677)', async () => {
    const dismissed: RepoChecksView = { repos: [repoChecks('org/b', { ...noChecks, dismissed: true })] };
    await boot(fixture, 'viewer', checksFixture);
    const group = (repo: string) => document.querySelector(`[data-repo="${repo}"]`)!;
    await vi.waitFor(() => expect(group('org/b').querySelector('[data-slot="repo-no-checks"]')).not.toBeNull());
    expect(text('[data-slot="repo-checks-job"]', group('org/b'))).toContain('Add PR checks to org/b');
    expect([...group('org/b').querySelectorAll('[data-slot="repo-checks-job"] button')]).toEqual([]);
    await unmount();
    await boot(fixture, 'admin', dismissed);
    await vi.waitFor(() => expect(group('org/b').querySelector('[data-slot="repo-no-checks"]')).not.toBeNull());
    expect(group('org/b').querySelector('[data-slot="repo-checks-job"]')).toBeNull();
  });

  it('a job\'s pull request merged into the landing branch is listed with its batch stage (issue #1073)', async () => {
    const landing = (over: Partial<LandingCard>): LandingCard => ({
      jobId: 'j12', repo: 'owner/a', issue: 'https://github.com/owner/a/issues/1', pullRequest: { number: 12, url: 'https://github.com/owner/a/pull/12' },
      stage: 'waiting', since: '2026-10-08T10:00:00.000Z', ...over,
    });
    const cards = [
      landing({}), landing({ jobId: 'j13', pullRequest: { number: 13, url: 'https://github.com/owner/a/pull/13' }, stage: 'batch_run', batch: 100 }),
      landing({ jobId: 'j14', pullRequest: { number: 14, url: 'https://github.com/owner/a/pull/14' }, stage: 'reverted', revert: 101, fixIssue: 'https://github.com/owner/a/issues/105' }),
    ];
    await boot({ ...fixture, landing: cards });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="landing"]')).not.toBeNull());
    expect([...document.querySelectorAll('[data-landing]')].map((e) => e.getAttribute('data-landing'))).toEqual(['j12', 'j13', 'j14']);
    expect(text('[data-slot="landing-stage"]', document.querySelector('[data-landing="j13"]')!)).toBe('in batch run #100');
    expect(landingText(cards[0]!)).toBe('merged into the landing branch: waits for a batch run');
    expect(landingText(landing({ stage: 'bisecting' }))).toBe('its batch failed: a bisect tests it');
    expect(landingText(landing({ stage: 'culprit' }))).toBe('it fails the full test suite: the hopper reverts it');
    expect(landingText(landing({ stage: 'culprit', revert: 101 }))).toBe('it fails the full test suite: its revert #101 waits to merge');
    expect(landingText(cards[2]!)).toBe('reverted by #101: a fix issue is filed');
    // None: no Landing list.
    await boot(fixture);
    expect(document.querySelector('[data-slot="landing"]')).toBeNull();
  });

  it('no card in any repo: the view says no pull request waits', async () => {
    await boot({ yolo: { on: 0, total: 1 }, waiting: [], repos: [{ repo: 'owner/a', yolo: false, pullRequests: [] }] });
    expect(text('[data-slot="pr-empty"]')).toBe('No pull request waits.');
    expect(text('[data-slot="pr-waiting-line"]')).toBe('merging waits: nothing');
  });
});
