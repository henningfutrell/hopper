// GitHub through a personal access token (issue #1380, part 6, design.md "A personal access token"): a person attaches
// their GitHub source with a token of their own, with no GitHub App. The token is kept as the connection's access token,
// a system secret in the user's vault. The hopper lists the repositories the token reaches, for the person to choose the
// job repositories. GitHub refusing the token (a 401) ends only the connection: the source asks to connect again.
//
// Feature: a personal access token as the GitHub source
//   Scenario: a token GitHub takes connects, with no GitHub App, and is kept in the vault, not in the row
//   Scenario: the repositories the token reaches are read, by owner, for the job repositories
//   Scenario: a token GitHub refuses is not kept, and the panel says why
//   Scenario: the source email match refuses a token whose account lacks the email, and deletes nothing at GitHub
//   Scenario: a token connection is never deleted at GitHub: not when replaced, not at a disconnect
//   Scenario: GitHub refusing the token later ends the connection, told once
//   Scenario: the repositories a token reaches, read from GitHub, grouped by owner
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { tokenRepositories } from '../../src/connected-accounts/identity.ts';
import { conditionalAnswers } from '../../src/repo-checks/conditional.ts';
import { accountOf, memoryAccountStore, systemOf } from '../support/system-secrets.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { waitFor } from '../support/wait.ts';

const T0 = Date.parse('2026-10-15T10:00:00Z');
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const REACHED = [{ account: 'octo-user', repositorySelection: 'selected' as const, repositories: ['octo-user/tools'] }];

/** A device flow the person approves at once. */
const approved = (now: () => number): DeviceFlow => ({
  start: async () => ({
    userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: new Date(now() + 900_000),
    grant: async (): Promise<Grant> => ({ accessToken: 'ghu_device', grantedBy: 'device' }),
  }),
});

function setup(o: Partial<ConnectedAccountsOptions> & { emails?: string[] } = {}) {
  const now = T0;
  const state = { refused: new Set<string>(), emails: o.emails ?? ['ada@example.com'], read: [] as string[] };
  const deleted: string[] = [], told: string[] = [];
  const { store } = memoryAccountStore(undefined, { settings: { getJobRepositories: () => [], setJobRepositories: () => undefined } });
  const service = createConnectedAccounts({
    // No GitHub App: no client id.
    store, secrets: systemOf(store), apps: hopperApps({ github: { clientId: '' } }),
    whoIs: async (_p, token) => {
      if (state.refused.has(token)) throw new Error('Bad credentials');
      return { subject: '7', account: 'octo-user', verifiedEmails: state.emails };
    },
    installations: async () => { state.read.push('installations'); return []; },
    tokenRepositories: async () => { state.read.push('repositories'); return REACHED; },
    clock: { now: () => new Date(now) },
    logger: { info: () => undefined, warn: () => undefined },
    flows: { github: approved(() => now) },
    refresh: async () => { throw new Error('no refresh for a token'); },
    deleteToken: async (_p, token) => { deleted.push(token); },
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, store, state, deleted, told };
}

describe('a personal access token as the GitHub source', () => {
  it('connects with no GitHub App, keeps the token in the vault, and reads the repositories it reaches', async () => {
    const s = setup();
    const status = await s.service.connectToken('github', 'github_pat_1', {});
    expect(status).toMatchObject({ state: 'connected', account: 'octo-user', grantedBy: 'token', connectedBy: 'sources', installations: REACHED });
    expect(status.state === 'connected' && (status.installUrl ?? status.configUrl)).toBeFalsy();
    expect(s.state.read).toEqual(['repositories']);
    expect(await s.service.token('github')).toBe('github_pat_1');
    expect(accountOf(s.store)).toMatchObject({ account: 'octo-user', grantedBy: 'token', accessToken: 'github_pat_1' });
    const row = s.store.connectedAccounts.get('github'); // the row: who and when, no token
    expect(row).toMatchObject({ account: 'octo-user', grantedBy: 'token' });
    expect(JSON.stringify(row)).not.toContain('github_pat_1');
  });

  it('a token GitHub refuses is not kept, and says why', async () => {
    const s = setup();
    s.state.refused.add('github_pat_bad');
    const status = await s.service.connectToken('github', 'github_pat_bad', {});
    expect(status).toEqual({ provider: 'github', key: 'github', via: 'the hopper\'s app', state: 'failed', error: 'GitHub refused the token: Bad credentials' });
    expect(accountOf(s.store)).toBeUndefined();
  });

  it('the source email match refuses an account without the email, and deletes nothing at GitHub', async () => {
    const s = setup({ emails: ['someone@example.org'] });
    const status = await s.service.connectToken('github', 'github_pat_1', { email: 'ada@example.com' });
    expect(status.state === 'failed' && status.error).toMatch(/^the GitHub account octo-user has no verified email ada@example\.com/);
    expect(accountOf(s.store)).toBeUndefined();
    expect(s.deleted).toEqual([]);
  });

  it('with the email, connects and keeps it to match', async () => {
    const s = setup();
    expect(await s.service.connectToken('github', 'github_pat_1', { email: 'Ada@Example.com' })).toMatchObject({ state: 'connected', matchEmail: 'ada@example.com' });
  });

  it('a token connection is never deleted at GitHub: not when a device connect replaces it, not at a disconnect', async () => {
    const s = setup({ apps: hopperApps({ github: {} }) }); // the shipped app, for the device code
    await s.service.connectToken('github', 'github_pat_1', {});
    await s.service.connect('github', {});
    await waitFor(async () => (await s.service.status())[0]!.state !== 'waiting', { what: 'the device flow ended' });
    expect((await s.service.status())[0]).toMatchObject({ state: 'connected', grantedBy: 'device' });
    expect(s.deleted).toEqual([]);
    await s.service.connectToken('github', 'github_pat_2', {});
    expect(s.deleted).toEqual(['ghu_device']); // the app's grant it replaced is deleted, as before
    await s.service.disconnect('github');
    expect(s.deleted).toEqual(['ghu_device']);
    expect(accountOf(s.store)).toBeUndefined();
  });

  it('GitHub refusing the token later ends only the connection, told once', async () => {
    const s = setup();
    await s.service.connectToken('github', 'github_pat_1', {});
    await expect(s.service.renew('github', 'github_pat_1')).rejects.toThrow('GitHub\'s sign-in expired: Sources → Connect GitHub again');
    expect(s.told).toEqual(['octo-user: GitHub refused the token and there is no refresh token to renew it']);
    expect((await s.service.status())[0]).toMatchObject({ state: 'expired', account: 'octo-user' });
  });

  it('without the master key, keeps no token', async () => {
    const { store } = memoryAccountStore(undefined, { settings: { getJobRepositories: () => [], setJobRepositories: () => undefined } });
    const keyless = setup({ store, secrets: systemOf(store, null) });
    const status = await keyless.service.connectToken('github', 'github_pat_1', {});
    expect(status.state === 'failed' && status.error).toMatch(/the master key is missing/);
  });
});

describe('the repositories a token reaches', () => {
  it('reads every page of GitHub\'s list, grouped by owner, with the owner\'s picture (issue #2774)', async () => {
    const forge = await createFakeGitHub({ clientId: 'gh-client-id', issues: [
      { repo: 'octo-user/tools', number: 1, title: 'a', body: '', labels: [], author: 'octo-user' },
      { repo: 'octo-org/site', number: 2, title: 'b', body: '', labels: [], author: 'octo-user' },
    ] });
    cleanups.push(() => forge.close());
    forge.tokens.set('github_pat_1', 'octo-user');
    const app = hopperApps({ github: { url: forge.url, clientId: '' } }).github;
    const reached = await tokenRepositories(app, 'github_pat_1', conditionalAnswers());
    expect(reached).toEqual([
      { account: 'octo-org', avatarUrl: `${forge.url}/avatars/octo-org`, repositorySelection: 'selected', repositories: ['octo-org/site'] },
      { account: 'octo-user', avatarUrl: `${forge.url}/avatars/octo-user`, repositorySelection: 'selected', repositories: ['octo-user/tools'] },
    ]);
  });
});
