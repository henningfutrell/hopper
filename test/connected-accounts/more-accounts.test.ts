// More than one GitHub account per user (issue #1448, design.md "More than one GitHub account"): beside the first connected
// account, a user adds a further one with a personal access token. Each keeps its own row, tokens, repositories and job
// repositories, under its own key; a repository is a job repository of one account only; a job of a repository acts with
// the account whose job repositories hold it; the source email match applies to each; one that ends marks only itself.
//
// Feature: more than one GitHub account
//   Scenario: a further account is added with a token, under its own key, beside the first, and kept after a restart
//   Scenario: each account has its own job repositories, and a repository is a job repository of one account only
//   Scenario: the account of a repository acts for it; any other repository is the first account's
//   Scenario: a login connected already is not added again, and a refused token keeps nothing
//   Scenario: the source email match applies to a further account
//   Scenario: GitHub refusing a further account's token ends only that account, told once with its key
//   Scenario: removing a further account forgets it, its tokens and its job repositories; the first stays; its source reads it as ended
//   Scenario: with no first account, the token connects the first
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountSet, RepositoryTaken } from '../../src/connected-accounts/account-set.ts';
import type { ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { accountEvents } from '../../src/connected-accounts/runtime-options.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const T0 = Date.parse('2026-10-16T10:00:00Z');
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** Who each token is, and the repositories it reaches. */
const PEOPLE: Record<string, { subject: string; account: string; verifiedEmails: string[]; repos: string[] }> = {
  github_pat_home: { subject: '1', account: 'ada-home', verifiedEmails: ['ada@example.com'], repos: ['ada-home/tools', 'ada-home/site'] },
  github_pat_work: { subject: '2', account: 'ada-work', verifiedEmails: ['ada@example.com'], repos: ['acme/api', 'acme/web'] },
  github_pat_other: { subject: '3', account: 'ada-other', verifiedEmails: ['someone@example.com'], repos: ['other/x'] },
};

function memorySettings() {
  const repos = new Map<string, string[]>();
  return { getJobRepositories: (k: string) => repos.get(k) ?? [], setJobRepositories: (k: string, r: readonly string[]) => { repos.set(k, [...r]); } };
}

function setup(o: Partial<ConnectedAccountsOptions> & { store?: UserStore } = {}) {
  const refused = new Set<string>();
  const told: { account: string; reason: string }[] = [];
  const store = o.store ?? memoryAccountStore(undefined, { settings: memorySettings() }).store;
  const recorded: unknown[] = [];
  const recorder = accountEvents({ append: (e) => { recorded.push(e); return e as never; } });
  const set = createAccountSet({
    store, secrets: systemOf(store), apps: hopperApps({ github: { clientId: '' } }),
    whoIs: async (_p, token) => {
      const who = PEOPLE[token];
      if (!who || refused.has(token)) throw new Error('Bad credentials');
      return { subject: who.subject, account: who.account, verifiedEmails: who.verifiedEmails };
    },
    installations: async () => [],
    tokenRepositories: async (token) => { const who = PEOPLE[token]!; return [{ account: who.account, repositorySelection: 'selected', repositories: who.repos }]; },
    clock: { now: () => new Date(T0) },
    logger: { info: () => undefined, warn: () => undefined },
    refresh: async () => { throw new Error('no refresh for a token'); },
    ...recorder,
    ...o,
    onExpired: (key, account, reason) => { told.push({ account, reason }); recorder.onExpired!(key, account, reason); },
  });
  cleanups.push(() => set.stop());
  return { set, store, refused, told, recorded };
}

const BY = { email: 'ada@example.com' };

describe('more than one GitHub account', () => {
  it('adds a further account with a token, under its own key, beside the first, and keeps it after a restart', async () => {
    const s = setup();
    expect(await s.set.connectToken('github', 'github_pat_home', BY)).toMatchObject({ key: 'github', state: 'connected', account: 'ada-home' });
    const added = await s.set.add('github', 'github_pat_work', BY);
    expect(added).toMatchObject({ provider: 'github', key: 'github-2', state: 'connected', account: 'ada-work', grantedBy: 'token' });
    expect(s.set.keys()).toEqual(['github', 'github-2']);
    expect((await s.set.status()).map((a) => [a.key, a.state === 'connected' ? a.account : a.state])).toEqual([['github', 'ada-home'], ['github-2', 'ada-work']]);
    expect(await s.set.token('github')).toBe('github_pat_home');
    expect(await s.set.token('github-2')).toBe('github_pat_work');
    // Its own row, and its own tokens in the vault: never the first account's.
    expect(s.store.connectedAccounts.get('github-2')).toMatchObject({ account: 'ada-work' });
    expect(JSON.stringify(s.store.connectedAccounts.get('github-2'))).not.toContain('github_pat_work');
    expect(systemOf(s.store).open('connected-account.github-2.access-token')).toBe('github_pat_work');
    expect(systemOf(s.store).open('connected-account.github.access-token')).toBe('github_pat_home');

    const again = setup({ store: s.store });
    expect(again.set.keys()).toEqual(['github', 'github-2']);
    expect(again.set.account('github-2')).toBe('ada-work');
    expect(await again.set.token('github-2')).toBe('github_pat_work');
  });

  it('gives each account its own job repositories; a repository is a job repository of one account only', async () => {
    const s = setup();
    await s.set.connectToken('github', 'github_pat_home', BY);
    await s.set.add('github', 'github_pat_work', BY);
    const work = await s.set.choose('github-2', ['acme/api']);
    expect(work).toMatchObject({ key: 'github-2', jobRepositories: ['acme/api'] });
    expect(work.state === 'connected' && work.installations?.[0]?.repositories).toEqual(['acme/api', 'acme/web']);
    await s.set.choose('github', ['ada-home/tools']);
    expect(s.set.jobRepositories('github')).toEqual(['ada-home/tools']);
    expect(s.set.jobRepositories('github-2')).toEqual(['acme/api']);
    await expect(s.set.choose('github', ['ada-home/tools', 'ACME/api'])).rejects.toThrow(RepositoryTaken);
    await expect(s.set.choose('github', ['ada-home/tools', 'ACME/api'])).rejects.toThrow('acme/api (github-2)');
    expect(s.set.jobRepositories('github')).toEqual(['ada-home/tools']);
  });

  it('routes a repository to the account whose job repositories hold it; any other to the first', async () => {
    const s = setup();
    await s.set.connectToken('github', 'github_pat_home', BY);
    await s.set.add('github', 'github_pat_work', BY);
    await s.set.choose('github', ['ada-home/tools']);
    await s.set.choose('github-2', ['acme/api']);
    expect(s.set.keyFor('acme/api')).toBe('github-2');
    expect(s.set.keyFor('Acme/API')).toBe('github-2');
    expect(s.set.keyFor('ada-home/tools')).toBe('github');
    expect(s.set.keyFor('somewhere/else')).toBe('github');
    expect(s.set.keyFor(undefined)).toBe('github');
    expect(await s.set.token(s.set.keyFor('acme/api'))).toBe('github_pat_work');
  });

  it('refuses a login connected already, and keeps nothing of a token GitHub refuses', async () => {
    const s = setup();
    await s.set.connectToken('github', 'github_pat_home', BY);
    const twice = await s.set.add('github', 'github_pat_home', BY);
    expect(twice).toMatchObject({ state: 'failed', error: expect.stringContaining('ada-home is connected already (github)') });
    const bad = await s.set.add('github', 'github_pat_nobody', BY);
    expect(bad).toMatchObject({ state: 'failed', error: expect.stringContaining('refused the token') });
    expect(s.set.keys()).toEqual(['github']);
    expect(s.store.connectedAccounts.keys()).toEqual(['github']);
    // The key stays free: the next one added takes it.
    expect(await s.set.add('github', 'github_pat_work', BY)).toMatchObject({ key: 'github-2', state: 'connected' });
  });

  it('applies the source email match to a further account', async () => {
    const s = setup();
    await s.set.connectToken('github', 'github_pat_home', BY);
    const other = await s.set.add('github', 'github_pat_other', BY);
    expect(other).toMatchObject({ state: 'failed', error: expect.stringContaining('ada@example.com') });
    expect(s.set.keys()).toEqual(['github']);
    const off = setup({ store: s.store, sourceEmailMatch: () => false });
    expect(await off.set.add('github', 'github_pat_other', BY)).toMatchObject({ key: 'github-2', state: 'connected', account: 'ada-other' });
    const work = await off.set.add('github', 'github_pat_work', BY);
    expect(work).toMatchObject({ key: 'github-3', state: 'connected' });
  });

  it('ends only the further account GitHub refuses, told once with its key', async () => {
    const s = setup();
    await s.set.connectToken('github', 'github_pat_home', BY);
    await s.set.add('github', 'github_pat_work', BY);
    s.refused.add('github_pat_work');
    await expect(s.set.renew('github-2', 'github_pat_work')).rejects.toThrow();
    expect(s.set.expired('github-2')).toBe(true);
    expect(s.set.expired('github')).toBe(false);
    expect(s.set.account('github')).toBe('ada-home');
    expect(s.told).toEqual([{ account: 'ada-work', reason: expect.any(String) }]);
    expect(s.recorded).toContainEqual(expect.objectContaining({ type: 'connected_account.expired', data: expect.objectContaining({ provider: 'github', key: 'github-2', account: 'ada-work' }) }));
    const status = await s.set.status();
    expect(status.map((a) => [a.key, a.state])).toEqual([['github', 'connected'], ['github-2', 'expired']]);
  });

  it('forgets a removed further account, its tokens and its job repositories; the first stays', async () => {
    const s = setup();
    await s.set.connectToken('github', 'github_pat_home', BY);
    await s.set.add('github', 'github_pat_work', BY);
    await s.set.choose('github-2', ['acme/api']);
    expect(await s.set.disconnect('github-2')).toMatchObject({ key: 'github-2', state: 'not-connected' });
    expect(s.set.keys()).toEqual(['github']);
    expect(s.store.connectedAccounts.get('github-2')).toBeUndefined();
    expect(systemOf(s.store).stored('connected-account.github-2.access-token')).toBeUndefined();
    expect(s.set.keyFor('acme/api')).toBe('github');
    expect(s.set.account('github')).toBe('ada-home');
    // Its source, which finishes its own jobs, reads it as ended, with no repositories (issue #356).
    expect(s.set.account('github-2')).toBeUndefined();
    expect(s.set.ended('github-2')).toBe('GitHub account github-2 was removed: Sources → Add another GitHub account');
    expect(s.set.jobRepositories('github-2')).toEqual([]);
    await expect(s.set.token('github-2')).rejects.toThrow('was removed');
    expect(() => s.set.choose('github-2', [])).toThrow('no connected account github-2');
    // Added again, it starts with no job repositories.
    expect(await s.set.add('github', 'github_pat_work', BY)).toMatchObject({ key: 'github-2', jobRepositories: [] });
  });

  it('connects the first account when there is none', async () => {
    const s = setup();
    expect(await s.set.add('github', 'github_pat_work', BY)).toMatchObject({ key: 'github', state: 'connected', account: 'ada-work' });
    expect(s.set.keys()).toEqual(['github']);
  });
});
