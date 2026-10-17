// Issue #1380: the job page names the GitHub identity that acts for the job — the login its GitHub requests and pushes
// named (`as`), newest first; before it acted, its user's connected GitHub account, which will act; with none, why not.
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountStatus, DomainEvent } from '../../src/domain/types.ts';
import type { GitLabAccountStatus } from '../../src/domain/gitlab-account.ts';
import { actingIdentity, actingText, forgeOf, gitlabActingIdentity } from '../../ui/src/model/acting-identity.ts';

let seq = 0;
const event = (type: string, data: Record<string, unknown>): DomainEvent =>
  ({ seq: ++seq, type, schemaVersion: 1, at: '2026-10-15T00:00:00.000Z', jobId: 'j1', data } as unknown as DomainEvent);
const connected = (account: string): ConnectedAccountStatus =>
  ({ provider: 'github', key: 'github', via: 'device', state: 'connected', account, connectedAt: '2026-10-15T00:00:00.000Z', jobRepositories: [] } as unknown as ConnectedAccountStatus);

describe('the GitHub identity that acts for a job (issue #1380)', () => {
  it('is the login its newest GitHub request or push named', () => {
    const newestFirst = [
      event('job.output', { line: 'x' }),
      event('github_proxy.done', { requestId: 'r2', as: 'second-login', op: 'git.push', repo: 'o/r', refs: [] }),
      event('github_proxy.refused', { requestId: 'r1', as: 'first-login', op: 'pr.create', reason: 'no' }),
    ];
    expect(actingIdentity(newestFirst, connected('now-login'))).toEqual({ kind: 'acted', login: 'second-login' });
  });

  it('before the job acted: its user\'s connected account, which will act; events from before #1380 name none', () => {
    const old = [event('github_proxy.done', { requestId: 'r', own: true, op: 'issue.view', repo: 'o/r', number: 1, url: 'u' })];
    expect(actingIdentity(old, connected('now-login'))).toEqual({ kind: 'connected', login: 'now-login' });
    expect(actingIdentity([], connected('now-login'))).toEqual({ kind: 'connected', login: 'now-login' });
  });

  it('with no connected account: none, and the text says how to connect one', () => {
    const expired = { provider: 'github', key: 'github', via: 'device', state: 'expired', account: 'gone' } as unknown as ConnectedAccountStatus;
    expect(actingIdentity([], expired)).toEqual({ kind: 'none' });
    expect(actingIdentity([], undefined)).toEqual({ kind: 'none' });
  });

  it('reads as plain words', () => {
    expect(actingText({ kind: 'acted', login: 'octocat' })).toBe('octocat');
    expect(actingText({ kind: 'connected', login: 'octocat' })).toBe('octocat (your connected GitHub account; it has not acted for this job yet)');
    expect(actingText({ kind: 'none' })).toBe('no GitHub account: Sources → Connect GitHub');
  });
});

// Issue #1448: before the job acted, the account that will act is the one whose job repositories hold the job's repository.
describe('the account that will act for a job (issue #1448)', () => {
  const at = (key: string, account: string, jobRepositories: string[]): ConnectedAccountStatus =>
    ({ provider: 'github', key, via: 'device', state: 'connected', account, connectedAt: '2026-10-16T00:00:00.000Z', jobRepositories } as unknown as ConnectedAccountStatus);
  const accounts = [at('github', 'ada-home', ['home/tools']), at('github-2', 'ada-work', ['acme/api'])];

  it('is the account of the job\'s repository, else the first', async () => {
    const { accountFor } = await import('../../ui/src/model/acting-identity.ts');
    expect(accountFor(accounts, 'Acme/API')).toMatchObject({ account: 'ada-work' });
    expect(accountFor(accounts, 'home/tools')).toMatchObject({ account: 'ada-home' });
    expect(accountFor(accounts, 'else/where')).toMatchObject({ account: 'ada-home' });
    expect(accountFor(accounts, undefined)).toMatchObject({ account: 'ada-home' });
    expect(actingIdentity([], accountFor(accounts, 'acme/api'))).toEqual({ kind: 'connected', login: 'ada-work' });
  });
});

describe('the GitLab identity that acts for a GitLab job (issue #1448 part 3)', () => {
  const gitlab = (state: string): GitLabAccountStatus => ({ state, account: 'ada-gl', baseUrl: 'https://gitlab.example', userId: 7, connectedAt: 'x', projects: [] } as unknown as GitLabAccountStatus);

  it('is the GitLab username its newest push named, never a GitHub login; before it pushed, the user\'s GitLab account', () => {
    const newestFirst = [event('github_proxy.done', { requestId: 'r2', as: 'octocat', op: 'issue.view', repo: 'o/r', number: 1, url: 'u' }), event('gitlab_proxy.done', { requestId: 'r1', as: 'ada-gl', op: 'git.push', project: 'ada/tools', refs: [] })];
    expect(gitlabActingIdentity(newestFirst, undefined)).toEqual({ kind: 'acted', login: 'ada-gl' });
    expect(actingIdentity(newestFirst.slice(1), undefined)).toEqual({ kind: 'none' });
    expect(gitlabActingIdentity([], gitlab('connected'))).toEqual({ kind: 'connected', login: 'ada-gl' });
    expect(gitlabActingIdentity([], gitlab('expired'))).toEqual({ kind: 'none' });
  });

  it('is named for its forge', () => {
    expect(forgeOf({ kind: 'gitlab-account' })).toBe('GitLab');
    expect(forgeOf({ kind: 'github-account' })).toBe('GitHub');
    expect(forgeOf(undefined)).toBe('GitHub');
    expect(actingText({ kind: 'connected', login: 'ada-gl' }, 'GitLab')).toBe('ada-gl (your connected GitLab account; it has not acted for this job yet)');
    expect(actingText({ kind: 'none' }, 'GitLab')).toBe('no GitLab account: Sources → Connect GitLab');
  });
});
