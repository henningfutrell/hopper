// Companion pull requests (issue #1143 reopened): an open pull request a job of an item opened through the hopper, in the
// item's own repository, that the item's newest job does not follow. Which ones the newest job holds, what a read keeps,
// and when a rebase is due for one.
import { describe, expect, it } from 'vitest';
import { asFollowing, companionDue, companionRebaseDue, companionRebaseText, companionsAfter, companionsOf, MAX_COMPANION_REBASE_ISSUES } from '../../src/domain/companion-pull-requests.ts';
import type { Job } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from '../sources/fixtures/github-support.ts';

const FOLLOWED = 'https://github.com/elsewhere/app/pull/24';
const OWN = `https://github.com/${REPO}/pull/7`;
const SECOND = `https://github.com/${REPO}/pull/8`;
const at = (m: number) => new Date(Date.UTC(2026, 9, 24, 12, m)).toISOString();
const job = (id: string, m: number, status: Job['status'], source: Record<string, unknown>, extra: Partial<Job> = {}): Job =>
  jobForIssue(1, { id, status, createdAt: at(m), sourceState: { source }, ...extra });
const none = () => undefined;
const always = () => true;

describe('companion pull requests (issue #1143 reopened)', () => {
  it('a finished job that follows one pull request holds the other ones it opened in its own repository', () => {
    const j = job('job-1', 0, 'finished', { pullRequest: FOLLOWED, follow: 'open' });
    const opened = (id: string) => (id === 'job-1' ? [OWN, FOLLOWED] : []);
    expect(companionsOf([j], opened, none, always)).toEqual([{ holder: j, companions: [OWN] }]);
  });

  it('it holds the ones it opened in another repository too (issue #2752): a pull request of a repository the hopper does not work on', () => {
    const j = job('job-1', 0, 'finished', { pullRequest: OWN, follow: 'open' });
    const opened = (id: string) => (id === 'job-1' ? [OWN, FOLLOWED, 'https://gitlab.example/group/app/-/merge_requests/3'] : []);
    expect(companionsOf([j], opened, none, always)).toEqual([{ holder: j, companions: [FOLLOWED] }]);
  });

  it('the newest job of the item holds the ones every job of the item opened, but the one it follows', () => {
    const first = job('job-1', 0, 'finished', { pullRequest: OWN, follow: 'tended' });
    const tend = job('job-2', 1, 'finished', { pullRequest: OWN, follow: 'open' }, { rerunOf: 'job-1' });
    const opened = (id: string) => (id === 'job-1' ? [SECOND, OWN] : []);
    expect(companionsOf([first, tend], opened, (id) => [first, tend].find((x) => x.id === id), always)).toEqual([{ holder: tend, companions: [SECOND] }]);
  });

  it('a job at work, a tended job, a cancelled job or an item that is over holds none', () => {
    const opened = () => [OWN];
    expect(companionsOf([job('job-1', 0, 'running', {})], opened, none, always)).toEqual([]);
    expect(companionsOf([job('job-1', 0, 'finished', { follow: 'tended' })], opened, none, always)).toEqual([]);
    expect(companionsOf([job('job-1', 0, 'cancelled', {})], opened, none, always)).toEqual([]);
    expect(companionsOf([job('job-1', 0, 'finished', {})], opened, none, () => false)).toEqual([]);
  });

  it('one a read saw end is read no more', () => {
    const j = job('job-1', 0, 'finished', { companions: { [OWN]: { conflicting: false, ended: true } } });
    expect(companionsOf([j], () => [OWN, SECOND], none, always)).toEqual([{ holder: j, companions: [SECOND] }]);
  });

  it('a read keeps what it saw; one not read stays as it was', () => {
    const j = job('job-1', 0, 'finished', { companions: { [SECOND]: { conflicting: true } } });
    expect(companionsAfter(j, [OWN, SECOND], [{ url: OWN, state: 'open', conflicting: true, base: 'main', headRef: 'issue-1-x' }]))
      .toEqual({ [OWN]: { conflicting: true, base: 'main', headRef: 'issue-1-x' }, [SECOND]: { conflicting: true } });
    expect(companionsAfter(j, [SECOND], [{ url: SECOND, state: 'merged', conflicting: false }])).toEqual({ [SECOND]: { conflicting: false, ended: true } });
  });

  it('a rebase is due for one with merge conflicts, not while the followed one needs a tend itself', () => {
    const companions = { [OWN]: { conflicting: true, base: 'main', headRef: 'issue-1-x' } };
    const j = job('job-1', 0, 'finished', { pullRequest: FOLLOWED, follow: 'open', seen: { draft: false, conflicting: false, checks: 'passing' }, companions });
    expect(companionDue(j, none)).toEqual({ url: OWN, base: 'main', headRef: 'issue-1-x' });
    const busy = job('job-1', 0, 'finished', { pullRequest: FOLLOWED, follow: 'open', seen: { draft: false, conflicting: true, checks: 'passing' }, companions });
    expect(companionDue(busy, none)).toBeUndefined();
    expect(companionDue(job('job-1', 0, 'finished', { companions: { [OWN]: { conflicting: false } } }), none)).toBeUndefined();
    expect(companionDue(job('job-1', 0, 'finished', { follow: 'tended', companions }), none)).toBeUndefined();
  });

  it('as if it followed its companion: its URL, base and head branch', () => {
    const j = job('job-1', 0, 'finished', { pullRequest: FOLLOWED, follow: 'open', companions: { [OWN]: { conflicting: true, base: 'main', headRef: 'issue-1-x' } } });
    expect(asFollowing(j, OWN).sourceState?.source).toMatchObject({ pullRequest: OWN, seen: { base: 'main', headRef: 'issue-1-x' } });
    expect(asFollowing(j, FOLLOWED)).toBe(j);
  });
});

describe('a rebase issue for a done item\'s companion (issue #1143 reopened)', () => {
  it('a read keeps the head commit, and the rebase issue filed for it', () => {
    const j = job('job-1', 0, 'finished', { companions: { [OWN]: { conflicting: true, head: 'a1', rebaseFiled: { head: 'a1', count: 1 } } } });
    expect(companionsAfter(j, [OWN], [{ url: OWN, state: 'open', conflicting: true, base: 'main', headRef: 'issue-1-x', head: 'b2' }]))
      .toEqual({ [OWN]: { conflicting: true, base: 'main', headRef: 'issue-1-x', head: 'b2', rebaseFiled: { head: 'a1', count: 1 } } });
  });

  it('is due once for each head commit of a companion with merge conflicts, at most a few times', () => {
    const at = (c: Record<string, unknown>) => job('job-1', 0, 'finished', { pullRequest: FOLLOWED, follow: 'open', companions: { [OWN]: { conflicting: true, base: 'main', headRef: 'issue-1-x', head: 'a1', ...c } } });
    expect(companionRebaseDue(at({}))).toEqual({ url: OWN, base: 'main', headRef: 'issue-1-x', head: 'a1', count: 0 });
    expect(companionRebaseDue(at({ rebaseFiled: { head: 'a1', count: 1 } }))).toBeUndefined();
    expect(companionRebaseDue(at({ rebaseFiled: { head: 'z9', count: 1 } }))).toEqual({ url: OWN, base: 'main', headRef: 'issue-1-x', head: 'a1', count: 1 });
    expect(companionRebaseDue(at({ rebaseFiled: { head: 'z9', count: MAX_COMPANION_REBASE_ISSUES } }))).toBeUndefined();
    expect(companionRebaseDue(at({ conflicting: false }))).toBeUndefined();
    expect(companionRebaseDue(at({ ended: true }))).toBeUndefined();
  });

  it('its text names the pull request, its branch and base, and the item, and asks for no new pull request', () => {
    const t = companionRebaseText({ repo: REPO, number: 17 }, { url: FOLLOWED, base: 'main', headRef: 'issue-17-notes' });
    expect(t.title).toBe('Rebase elsewhere/app#24 onto main');
    expect(t.body).toContain(FOLLOWED);
    expect(t.body).toContain('`issue-17-notes`');
    expect(t.body).toContain(`${REPO}#17`);
    expect(t.body).toContain('Do not open a new pull request.');
    expect(companionRebaseText({ repo: REPO, number: 17 }, { url: OWN }).title).toBe('Rebase #7 onto its base branch');
  });
});
