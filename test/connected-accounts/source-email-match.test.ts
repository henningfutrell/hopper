// The source email match (issue #1380, part 4, design.md "The source email match"): a GitHub account a person connects from
// Sources must have a verified email equal to the email they signed in with. On by default; the hopper's admin may turn it
// off. Checked at the connect, and again at each renewal of the account's token: an account that lost the email reads
// expired, so its source asks to connect again, and the person stays signed in.
//
// Feature: the source email match
//   Scenario: an account with the person's email among its verified emails connects, and keeps that email
//   Scenario: an account without it is refused with a clear message, and nothing is kept
//   Scenario: GitHub not showing the account's emails is refused the same way
//   Scenario: with the setting off, the account connects anyway
//   Scenario: a person whose sign-in gave no email has nothing to match: the account connects
//   Scenario: a renewal checks again: an account that lost the email reads expired, told once
//   Scenario: a renewal with the setting off, or GitHub not answering the check, ends nothing
//   Scenario: who a token belongs to lists every verified email GitHub shows
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { whoIs } from '../../src/connected-accounts/identity.ts';
import { accountOf, memoryAccountStore, systemOf } from '../support/system-secrets.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { waitFor } from '../support/wait.ts';

const H = 3600_000;
const T0 = Date.parse('2026-10-15T10:00:00Z');
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

let minted = 0;
const grant = (now: number): Grant => ({
  accessToken: `ghu_${++minted}`, refreshToken: `ghr_${minted}`, grantedBy: 'device',
  expiresAt: new Date(now + 8 * H), refreshTokenExpiresAt: new Date(now + 180 * 24 * H),
});

/** A device flow the person approves at once. */
const approved = (now: () => number): DeviceFlow => ({
  start: async () => ({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: new Date(now() + 900_000), grant: async () => grant(now()) }),
});

function setup(o: { on?: boolean; emails?: string[] | undefined } & Partial<ConnectedAccountsOptions> = {}) {
  let now = T0;
  const state = { on: o.on ?? true, emails: 'emails' in o ? o.emails : ['ada@example.com', 'ada@work.example'], whoIsFails: false };
  const told: string[] = [];
  const { store } = memoryAccountStore(undefined, { settings: { getJobRepositories: () => [], setJobRepositories: () => undefined } });
  const service = createConnectedAccounts({
    store, secrets: systemOf(store), apps: hopperApps({ github: {} }),
    whoIs: async () => {
      if (state.whoIsFails) throw new Error('connect ECONNREFUSED');
      return { subject: '1', account: 'octo-user', ...(state.emails ? { verifiedEmails: state.emails } : {}) };
    },
    installations: async () => [],
    clock: { now: () => new Date(now) },
    logger: { info: () => undefined, warn: () => undefined },
    flows: { github: approved(() => now) },
    refresh: async () => grant(now),
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    sourceEmailMatch: () => state.on,
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, store, state, told, later: (ms: number) => { now += ms; } };
}

/** Connect as the person signed in with `email`; resolves once the device flow ended, connected or not. */
async function connect(s: ReturnType<typeof setup>, email: string | undefined) {
  await s.service.connect('github', email === undefined ? {} : { email });
  await waitFor(async () => (await s.service.status())[0]!.state !== 'waiting', { what: 'the device flow ended' });
  return (await s.service.status())[0]!;
}

describe('the source email match at the connect', () => {
  it('connects an account whose verified emails hold the email the person signed in with, and keeps that email', async () => {
    const s = setup();
    expect(await connect(s, 'Ada@Example.com')).toMatchObject({ state: 'connected', account: 'octo-user', matchEmail: 'ada@example.com' });
    expect(accountOf(s.store)).toMatchObject({ account: 'octo-user', matchEmail: 'ada@example.com' });
  });

  it('refuses an account without that email, with a clear message, and keeps nothing', async () => {
    const s = setup({ emails: ['someone@example.org'] });
    const status = await connect(s, 'ada@example.com');
    expect(status).toMatchObject({ state: 'failed' });
    expect(status.state === 'failed' && status.error).toBe(
      'the GitHub account octo-user has no verified email ada@example.com, the email you signed in with: add and verify it at GitHub, then connect again, or ask the hopper\'s admin to turn off the source email match (Settings → Sign-in)');
    expect(accountOf(s.store)).toBeUndefined();
    expect(s.service.account('github')).toBeUndefined();
  });

  it('refuses an account whose emails GitHub does not show', async () => {
    const s = setup({ emails: undefined });
    const status = await connect(s, 'ada@example.com');
    expect(status.state === 'failed' && status.error).toMatch(/^GitHub did not show the verified emails of octo-user, so the hopper cannot check ada@example\.com/);
    expect(accountOf(s.store)).toBeUndefined();
  });

  it('with the setting off, connects the account anyway, and keeps no email to match', async () => {
    const s = setup({ on: false, emails: ['someone@example.org'] });
    const status = await connect(s, 'ada@example.com');
    expect(status).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(accountOf(s.store)?.matchEmail).toBeUndefined();
  });

  it('a person whose sign-in gave no email has nothing to match: the account connects', async () => {
    const s = setup({ emails: ['someone@example.org'] });
    expect(await connect(s, undefined)).toMatchObject({ state: 'connected', account: 'octo-user' });
    expect(accountOf(s.store)?.matchEmail).toBeUndefined();
  });
});

describe('the source email match at each renewal', () => {
  it('an account that lost the email reads expired at its renewal, told once; nothing signs the person out', async () => {
    const s = setup();
    await connect(s, 'ada@example.com');
    s.state.emails = ['someone@example.org'];
    s.later(7.5 * H);
    await expect(s.service.token('github')).rejects.toThrow('GitHub\'s sign-in expired: Sources → Connect GitHub again');
    expect(s.told).toEqual(['octo-user: the GitHub account octo-user no longer has the verified email ada@example.com, the email it was connected for']);
    expect((await s.service.status())[0]).toMatchObject({ state: 'expired', error: expect.stringMatching(/no longer has the verified email/) });
  });

  it('an account that still has the email renews and stays connected', async () => {
    const s = setup();
    await connect(s, 'ada@example.com');
    const before = accountOf(s.store)!.accessToken;
    s.later(7.5 * H);
    const token = await s.service.token('github');
    expect(token).not.toBe(before);
    expect(accountOf(s.store)).toMatchObject({ accessToken: token, matchEmail: 'ada@example.com' });
    expect(s.told).toEqual([]);
  });

  it('with the setting off, a renewal does not check', async () => {
    const s = setup();
    await connect(s, 'ada@example.com');
    s.state.on = false;
    s.state.emails = ['someone@example.org'];
    s.later(7.5 * H);
    await s.service.token('github');
    expect((await s.service.status())[0]).toMatchObject({ state: 'connected' });
  });

  it('GitHub not answering the check ends nothing', async () => {
    const s = setup();
    await connect(s, 'ada@example.com');
    s.state.whoIsFails = true;
    s.later(7.5 * H);
    await s.service.token('github');
    expect((await s.service.status())[0]).toMatchObject({ state: 'connected' });
    expect(s.told).toEqual([]);
  });
});

describe('who a token belongs to', () => {
  it('lists every verified email GitHub shows', async () => {
    const github = await createFakeGitHub({ clientId: 'gh-client-id' });
    cleanups.push(() => github.close());
    const app = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } }).github;
    const who = await whoIs(app, github.mint('octo-user').accessToken);
    expect(who).toMatchObject({ account: 'octo-user', email: 'octo-user@example.com', verifiedEmails: ['octo-user@example.com'] });
  });
});
