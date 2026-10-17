// A user's GitLab account (issue #1448 part 2, design.md "A GitLab source"): attached with a personal access token, at
// gitlab.com or a GitLab of the user's own; GitLab must take the token, and the source email match applies; the token is a
// system secret in the user's vault, never in the record or an answer; the projects it reaches are read, and the projects
// picked are kept; GitLab refusing the token later ends this account only; removing it forgets the token. Over a fake GitLab
// on loopback (test/support/fake-gitlab.ts).
//
// Feature: a GitLab account
//   Scenario: a token connects the account it is; its token is kept sealed in the vault, never in the record or the status
//   Scenario: a refused token, or a URL that is not https, keeps nothing, and an account there was stays as it was
//   Scenario: the source email match: a confirmed email must be the session's; an unconfirmed one, or emails not shown, refuse; off, none is checked
//   Scenario: the projects picked are kept; a new token of the same account keeps them, another account's does not
//   Scenario: GitLab refusing the token ends the account, once, and its source pauses; a new token connects it again
//   Scenario: removing the account forgets its token
import { afterEach, describe, expect, it } from 'vitest';
import { createGitLabAccount } from '../../src/gitlab/account.ts';
import type { GitLabAccountRecord } from '../../src/domain/gitlab-account.ts';
import { createFakeGitLab, type FakeGitLab } from '../support/fake-gitlab.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const ADA = { id: 7, username: 'ada', email: 'ada@example.com', emails: [{ email: 'ada@work.example' }, { email: 'ada@old.example', confirmed: false }], projects: ['ada/tools', 'acme/platform/api'] };

async function setup(o: { emailMatch?: boolean } = {}) {
  const gitlab = await createFakeGitLab();
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', ADA);
  gitlab.tokens.set('glpat-ada-new', ADA);
  gitlab.tokens.set('glpat-bob', { id: 8, username: 'bob', email: 'bob@example.com', projects: ['bob/x'] });
  let kept: GitLabAccountRecord | undefined;
  const settings = { getGitLabAccount: () => (kept ? structuredClone(kept) : undefined), setGitLabAccount: (r: GitLabAccountRecord | null) => { kept = r ?? undefined; } };
  const { store } = memoryAccountStore();
  const secrets = systemOf(store);
  const changes: boolean[] = [];
  const warned: string[] = [];
  const account = createGitLabAccount({
    settings, secrets, clock: { now: () => new Date('2026-10-17T08:00:00Z') }, emailMatch: () => o.emailMatch ?? true,
    onChange: (presence) => changes.push(presence), logger: { info: () => undefined, warn: (l) => warned.push(l) },
  });
  return { gitlab, account, settings, secrets, changes, warned, record: () => kept };
}

const connect = (s: Awaited<ReturnType<typeof setup>>, token = 'glpat-ada', email: string | undefined = 'ada@example.com', gitlab: FakeGitLab = s.gitlab) =>
  s.account.connect({ token, baseUrl: gitlab.url }, email ? { email } : {});

describe('a GitLab account', () => {
  it('connects the account a token is, and keeps the token sealed in the vault, never in the record or the status', async () => {
    const s = await setup();
    const status = await connect(s);
    expect(status).toMatchObject({ state: 'connected', account: 'ada', userId: 7, baseUrl: s.gitlab.url, matchEmail: 'ada@example.com', projects: [], reached: ['ada/tools', 'acme/platform/api'] });
    expect(s.changes).toEqual([true]);
    expect(JSON.stringify(s.record())).not.toContain('glpat');
    expect(JSON.stringify(status)).not.toContain('glpat');
    expect(s.secrets.open('gitlab-account.access-token')).toBe('glpat-ada');
    expect(s.secrets.stored('gitlab-account.access-token')).not.toContain('glpat');
    expect(s.gitlab.requests.every((r) => r.token === 'glpat-ada' && !r.path.includes('glpat'))).toBe(true);
  });

  it('keeps nothing for a refused token or a URL that is not https, and an account there was stays as it was', async () => {
    const s = await setup();
    expect(await connect(s, 'glpat-nobody')).toMatchObject({ state: 'failed', error: expect.stringContaining('GitLab refused the token') });
    expect(s.account.status()).toMatchObject({ state: 'not-connected', error: expect.stringContaining('GitLab refused the token') });
    expect(await s.account.connect({ token: 'glpat-ada', baseUrl: 'http://gitlab.example.com' })).toMatchObject({ state: 'failed', error: expect.stringContaining('https') });
    expect(await s.account.connect({ token: 'glpat-ada', baseUrl: 'https://user:pw@gitlab.example.com' })).toMatchObject({ state: 'failed' });
    expect(s.secrets.open('gitlab-account.access-token')).toBeUndefined();
    await connect(s);
    expect(await connect(s, 'glpat-nobody')).toMatchObject({ state: 'failed' });
    expect(s.account.status()).toMatchObject({ state: 'connected', account: 'ada' });
    expect(s.secrets.open('gitlab-account.access-token')).toBe('glpat-ada');
  });

  it('applies the source email match: a confirmed email of the account must be the one signed in with', async () => {
    const s = await setup();
    expect(await connect(s, 'glpat-ada', 'Ada@Work.example')).toMatchObject({ state: 'connected', matchEmail: 'ada@work.example' });
    s.account.disconnect();
    expect(await connect(s, 'glpat-ada', 'ada@old.example')).toMatchObject({ state: 'failed', error: expect.stringContaining('no confirmed email ada@old.example') });
    expect(await connect(s, 'glpat-bob', 'ada@example.com')).toMatchObject({ state: 'failed', error: expect.stringContaining('no confirmed email') });
    s.gitlab.tokens.set('glpat-hidden', { ...ADA, mayReadEmails: false });
    expect(await connect(s, 'glpat-hidden', 'ada@example.com')).toMatchObject({ state: 'failed', error: expect.stringContaining('did not show the confirmed emails') });
    expect(s.account.status().state).toBe('not-connected');
    const off = await setup({ emailMatch: false });
    const status = await connect(off, 'glpat-bob', 'ada@example.com');
    expect(status).toMatchObject({ state: 'connected', account: 'bob' });
    expect(status).not.toHaveProperty('matchEmail');
  });

  it('keeps the projects picked; a new token of the same account keeps them, another account\'s does not', async () => {
    const s = await setup();
    await connect(s);
    expect(s.account.paused()).toContain('no GitLab project is picked');
    expect(s.account.choose(['acme/platform/api'])).toMatchObject({ state: 'connected', projects: ['acme/platform/api'] });
    expect(() => s.account.choose(['not a project'])).toThrow('not a GitLab project path');
    expect(s.account.paused()).toBeUndefined();
    expect(await connect(s, 'glpat-ada-new')).toMatchObject({ projects: ['acme/platform/api'] });
    expect(s.changes).toEqual([true, false, false]);
    expect(await connect(s, 'glpat-bob', '')).toMatchObject({ account: 'bob', projects: [], reached: ['bob/x'] });
  });

  it('ends the account once when GitLab refuses its token, pauses its source, and connects again with a new token', async () => {
    const s = await setup();
    await connect(s);
    s.account.choose(['ada/tools']);
    s.gitlab.refused.add('glpat-ada');
    await expect(s.account.issues('ada/tools', 'hopper')).rejects.toThrow('401');
    await expect(s.account.issues('ada/tools', 'hopper')).rejects.toThrow('no GitLab account is connected');
    expect(s.account.status()).toMatchObject({ state: 'expired', account: 'ada', projects: ['ada/tools'], error: expect.stringContaining('401') });
    expect(s.account.paused()).toContain('GitLab refused the token of ada');
    expect(s.warned.filter((l) => l.includes('ended'))).toHaveLength(1);
    expect(await connect(s, 'glpat-ada-new')).toMatchObject({ state: 'connected', projects: ['ada/tools'] });
  });

  it('forgets the account and its token when it is removed', async () => {
    const s = await setup();
    await connect(s);
    expect(s.account.disconnect()).toEqual({ state: 'not-connected' });
    expect(s.secrets.open('gitlab-account.access-token')).toBeUndefined();
    expect(s.record()).toBeUndefined();
    expect(s.changes).toEqual([true, true]);
    expect(() => s.account.choose([])).toThrow('no GitLab account');
  });
});
