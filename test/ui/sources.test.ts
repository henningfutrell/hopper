// The Sources view's GitHub section (issues #160, #214, #254, #359, #1377): the GitHub sign-in is the one way the hopper
// reads and writes GitHub. The summary line reads the sign-in and its job repositories, never only whether a source status
// exists: it never says no connection is configured while a person is signed in with GitHub; with no repositories it asks to
// choose them; with an expired token, to sign in again; with a source that cannot run, why.
import { describe, expect, it } from 'vitest';
import { sourcesView } from '../../ui/src/model/sources.ts';
import type { ConnectedAccountStatus, SourceStatus } from '../../ui/src/model/wire.ts';
import { CONNECTED_VIA } from '../../src/domain/types.ts';

const NOT_CONNECTED = 'GitHub is not connected: Sources → Connect GitHub';
const EXPIRED = "GitHub's sign-in expired: Sources → Connect GitHub again";
const NO_REPOSITORIES = 'no repositories chosen for jobs: Sources → GitHub account → choose them';

const source = (name: string, kind: string, state: SourceStatus['state'], detail: Record<string, unknown> = {}, more: Partial<SourceStatus> = {}): SourceStatus =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail, ...more });
const account = (login?: string, paused = NOT_CONNECTED) => source('github-account', 'github-account', login ? 'ok' : 'disabled', {
  ...(login ? { login } : { paused }),
});
const BASE = { provider: 'github', key: 'github', via: CONNECTED_VIA } as const;
const signedIn = (jobRepositories: string[] = ['o/r']): ConnectedAccountStatus =>
  ({ ...BASE, state: 'connected', account: 'octo-user', connectedAt: '2026-10-15T10:00:00Z', jobRepositories, configUrl: 'https://github.com/settings/installations' }) as ConnectedAccountStatus;

describe('sourcesView', () => {
  it('signed in, repositories chosen: the connection reads issues', () => {
    const acc = account('octo-user');
    const v = sourcesView([acc], signedIn());
    expect(v.account).toBe(acc);
    expect(v.connected).toBe(true);
    expect(v.github).toEqual([]);
    expect(v.others).toEqual([]);
    expect(v.summary).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user.');
  });

  it('signed in, no repositories chosen: it asks to choose them', () => {
    const v = sourcesView([account(undefined, NO_REPOSITORIES)], signedIn([]));
    expect(v.summary).toBe('Signed in with GitHub as octo-user. Choose the repositories for jobs below: until then no issue is read.');
  });

  it('a sign-in whose token expired: it asks to sign in again', () => {
    const expired = { ...BASE, state: 'expired', account: 'octo-user', connectedAt: '2026-10-15T10:00:00Z', error: EXPIRED } as ConnectedAccountStatus;
    expect(sourcesView([account(undefined, EXPIRED)], expired).summary).toBe('Your GitHub sign-in expired. Sign in with GitHub again to read issues and work through it.');
  });

  it('signed in, the source missing or unable to run: never "no connection configured", and it says why', () => {
    for (const v of [sourcesView([], signedIn()), sourcesView([source('github-account', 'github-account', 'error', {}, { lastError: 'invalid options: pollSeconds' })], signedIn())]) {
      expect(v.summary).not.toMatch(/No GitHub connection is configured/);
      expect(v.summary).toMatch(/^Signed in with GitHub as octo-user, but its job source/);
    }
    expect(sourcesView([source('github-account', 'github-account', 'error', {}, { lastError: 'invalid options: pollSeconds' })], signedIn()).summary)
      .toBe('Signed in with GitHub as octo-user, but its job source cannot run: invalid options: pollSeconds.');
    expect(sourcesView([source('github-account', 'github-account', 'disabled', {})], signedIn()).summary)
      .toBe('Signed in with GitHub as octo-user, but its job source is switched off in Plugins.');
  });

  it('not signed in: it says how to sign in', () => {
    const v = sourcesView([account()], { ...BASE, state: 'not-connected' } as ConnectedAccountStatus);
    expect(v.connected).toBe(false);
    expect(v.summary).toBe('Sign in with GitHub, or connect GitHub below, to read issues and work through it.');
  });

  it('before the sign-in is read: the source says it, and never "no connection configured"', () => {
    expect(sourcesView([account()]).summary).toBe(`No issue is read through your GitHub connection: ${NOT_CONNECTED}.`);
    expect(sourcesView([account('octo-user')]).summary).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user.');
    expect(sourcesView([]).summary).not.toMatch(/No GitHub connection is configured/);
  });

  it('a second connected-account source is a card of its own; other sources stay out of the GitHub section', () => {
    const other = source('linear', 'linear', 'ok');
    const second = { ...account('octo-user'), name: 'gh-2', duplicateOf: 'github-account' };
    const v = sourcesView([other, account('octo-user'), second]);
    expect(v.github.map((s) => s.name)).toEqual(['gh-2']);
    expect(v.others).toEqual([other]);
    expect(v.duplicates).toEqual([second]);
  });
});

// Issue #1448: a further GitHub account's source names its account; it is shown in that account's panel, never as a card,
// and never taken for the first account's source.
describe('sourcesView: a further GitHub account', () => {
  it('keeps each further account\'s source apart, by its key, out of the cards', () => {
    const first = account('octo-user');
    const work = source('github-account-2', 'github-account', 'ok', { login: 'octo-work', accountKey: 'github-2' });
    const v = sourcesView([work, first], signedIn());
    expect(v.account).toBe(first);
    expect(v.further).toEqual({ 'github-2': work });
    expect(v.github).toEqual([]);
  });

  it('the header asks to connect again for a further account that ended, after the first', async () => {
    const { connectionEnded } = await import('../../ui/src/model/sources.ts');
    const work = source('github-account-2', 'github-account', 'disabled', { accountKey: 'github-2', expired: true, paused: 'work ended' });
    expect(connectionEnded([account('octo-user'), work])).toBe('work ended');
    expect(connectionEnded([work, source('github-account', 'github-account', 'disabled', { expired: true, paused: 'first ended' })])).toBe('first ended');
  });
});

describe('sourcesView: the GitLab source (issue #1448 part 2)', () => {
  it('shows the GitLab account\'s source in the GitLab panel, never as a card of its own', () => {
    const gitlab = source('gitlab-account', 'gitlab-account', 'ok', { login: 'ada' });
    const other = source('direct', 'direct', 'ok');
    const v = sourcesView([gitlab, other], signedIn());
    expect(v.gitlab).toBe(gitlab);
    expect(v.others).toEqual([other]);
    expect(sourcesView([other]).gitlab).toBeUndefined();
  });
});
