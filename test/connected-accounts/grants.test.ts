// The hopper revokes nothing at GitHub when a connection is replaced (issue #597). GitHub's credential
// revocation (`POST /credentials/revoke`) is its leak report: it ends the whole authorization of the user at
// the app — the new token too — and GitHub emails the owner a security notice. So a connect or a sign-in with
// GitHub over a live grant leaves the old one to expire, and the new one keeps working. A disconnect deletes
// the dropped access token through the app token API, only with the client secret; without one it sends
// nothing. A new connection is checked at GitHub once kept: a token GitHub refuses reads as needing a
// reconnect at once. And a connection it cannot read (the token key changed) never pushes the person to mint
// a new grant: it says to give the key back, and an older key opens it as HOPPER_TOKEN_KEY_PREVIOUS.
// Real Postgres, the real check, token deletion and renewal over HTTP to a fake GitHub on loopback, a fake clock.
//
// Feature: no revocation at GitHub on connect or sign-in
//   Scenario: connecting again over a live grant revokes nothing, and the new connection renews hours later
//   Scenario: a sign-in with GitHub over a live grant revokes nothing, and the new connection keeps working
//   Scenario: disconnecting deletes the access token alone with the client secret; GitHub failing forgets it anyway
//   Scenario: disconnecting with no client secret sends nothing to GitHub and forgets the account
//   Scenario: a new connection whose token GitHub refuses when checked reads as needing a reconnect, told once
//   Scenario: a connection sealed under another key reads unreadable and says to give the key, not to connect again
//   Scenario: the old key given as HOPPER_TOKEN_KEY_PREVIOUS opens it, and the next look seals it under the new key
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccount, UserStore } from '../../src/domain/ports.ts';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { whoIs } from '../../src/connected-accounts/identity.ts';
import { renewal } from '../../src/connected-accounts/renewal.ts';
import { tokenDeletion } from '../../src/connected-accounts/token-deletion.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { waitFor } from '../support/wait.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const EIGHT_HOURS_S = 8 * 3600;
const H = 3600_000;
const T0 = '2026-10-08T10:00:00.000Z';
const SECRET = 'gh-client-secret';
const temp = useTempStore();
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function forge(o: { clientSecret?: string } = {}): Promise<FakeForge> {
  const f = await createFakeGitHub({ clientId: 'gh-client-id', tokenLifetimeS: EIGHT_HOURS_S, ...o });
  cleanups.push(() => f.close());
  return f;
}

function store(url: string, clock: ReturnType<typeof fixedClock>): UserStore {
  const s = temp.open(url, clock);
  cleanups.push(() => s.close());
  return s;
}

/** A device flow the person approves at once: GitHub mints a new grant for `login`, as the real one would. */
const approvedAs = (github: FakeForge, login: string, clock: ReturnType<typeof fixedClock>): DeviceFlow => ({
  start: async () => ({
    userCode: 'WDJB-MJHT', verificationUri: `${github.url}/login/device`, expiresAt: new Date(Date.now() + 900_000),
    grant: async (): Promise<Grant> => {
      const pair = github.mint(login);
      const now = clock.now().getTime();
      return { ...pair, grantedBy: 'device', expiresAt: new Date(now + EIGHT_HOURS_S * 1000), refreshTokenExpiresAt: new Date(now + 180 * 24 * H) };
    },
  }),
});

/** One hopper's connected accounts over its own connection to a user schema; `secret`: the app's client secret the runtime gives. */
function hopper(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>, o: Partial<ConnectedAccountsOptions> & { secret?: string } = {}) {
  const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
  const logs: string[] = [];
  const told: string[] = [];
  const service = createConnectedAccounts({
    store: s, apps, clock,
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    whoIs: async () => ({ subject: '1', account: 'octo-user' }),
    installations: async () => [],
    refresh: (p, refresh, grantedBy) => renewal(apps[p], () => o.secret)(refresh, grantedBy),
    deleteToken: (p, token) => tokenDeletion(apps[p], () => o.secret)(token),
    flows: { github: approvedAs(github, 'octo-user', clock) },
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, logs, told, apps };
}

/** Who a token belongs to, asked of the fake GitHub as the hopper asks the real one: a refused token throws its 401. */
const askGitHub = (github: FakeForge): ConnectedAccountsOptions['whoIs'] => (p, token) => whoIs(hopperApps({ github: { clientId: 'gh-client-id', url: github.url } })[p], token);

/** Connect (again): resolves once a new pair is kept and checked, the device code no longer waiting. */
async function connect(service: ReturnType<typeof hopper>['service'], s: UserStore): Promise<ConnectedAccount> {
  const before = s.connectedAccounts.get('github')?.accessToken;
  await service.connect('github');
  await waitFor(async () => {
    const now = s.connectedAccounts.get('github');
    return now !== undefined && now.accessToken !== before && (await service.status())[0]!.state !== 'waiting';
  }, { what: 'github connected' });
  return s.connectedAccounts.get('github')!;
}

/** What the hopper sent to GitHub's revocation or token APIs. */
const revocations = (github: FakeForge) => github.requests.filter((r) => r.path.endsWith('/credentials/revoke') || r.path.includes('/applications/'));

describe('no revocation at GitHub on connect or sign-in (#597)', () => {
  it('connecting again over a live grant revokes nothing, and the new connection renews hours later', async () => {
    const github = await forge({ clientSecret: SECRET });
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, told } = hopper(github, s, clock, { secret: SECRET });
    const first = await connect(service, s);
    const second = await connect(service, s);

    expect(revocations(github)).toEqual([]);
    expect(github.tokens.has(first.accessToken)).toBe(true); // left to expire
    expect(github.tokens.has(second.accessToken)).toBe(true);
    expect(await service.token('github')).toBe(second.accessToken);

    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const renewed = await service.token('github');
    expect(renewed).not.toBe(second.accessToken);
    expect(github.tokens.has(renewed)).toBe(true);
    expect(told).toEqual([]);
  });

  it('a sign-in with GitHub over a live grant revokes nothing, and the new connection keeps working', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, told } = hopper(github, s, clock, { whoIs: askGitHub(github) });
    const first = await connect(service, s);

    const signIn = github.mint('octo-user');
    await service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'device' });
    expect(revocations(github)).toEqual([]);
    expect(github.revoked).toEqual([]);
    expect(s.connectedAccounts.get('github')!.accessToken).toBe(signIn.accessToken);
    expect(github.tokens.has(first.accessToken)).toBe(true);
    // The new token was checked once kept, and GitHub took it.
    expect(github.requests.filter((r) => r.path === '/api/v3/user' && r.auth === `token ${signIn.accessToken}`)).toHaveLength(1);
    expect((await service.status())[0]).toMatchObject({ state: 'connected', account: 'octo-user' });

    // Renewed on a 401 and hours later, as ever: the authorization did not end.
    expect(await service.renew('github', signIn.accessToken)).not.toBe(signIn.accessToken);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    expect(github.tokens.has(await service.token('github'))).toBe(true);
    expect(told).toEqual([]);
  });

  it('disconnecting deletes the access token alone with the client secret; GitHub failing forgets it anyway, and says so', async () => {
    const github = await forge({ clientSecret: SECRET });
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, logs } = hopper(github, s, clock, { secret: SECRET });
    const first = await connect(service, s);

    expect(await service.disconnect('github')).toMatchObject({ state: 'not-connected' });
    expect(github.deleted).toEqual([first.accessToken]);
    expect(github.revoked).toEqual([]);
    const sent = revocations(github);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'DELETE', path: '/api/v3/applications/gh-client-id/token', body: { access_token: first.accessToken } });
    expect(sent[0]!.auth).toBe(`basic ${Buffer.from(`gh-client-id:${SECRET}`).toString('base64')}`);
    expect(JSON.stringify(sent[0]!.body)).not.toContain(first.refreshToken!); // the refresh token is never sent
    expect(s.connectedAccounts.get('github')).toBeUndefined();

    const second = await connect(service, s);
    github.deleteDown = 500;
    expect(await service.disconnect('github')).toMatchObject({ state: 'not-connected' });
    expect(s.connectedAccounts.get('github')).toBeUndefined();
    expect(github.tokens.has(second.accessToken)).toBe(true); // still alive at GitHub: said, not hidden
    expect(logs.some((l) => /could not delete the GitHub token/.test(l))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/gh[or]_/); // never a token in the log
  });

  it('disconnecting with no client secret sends nothing to GitHub and forgets the account', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, logs } = hopper(github, s, clock);
    const first = await connect(service, s);

    expect(await service.disconnect('github')).toMatchObject({ state: 'not-connected' });
    expect(revocations(github)).toEqual([]);
    expect(github.tokens.has(first.accessToken)).toBe(true); // it expires by itself
    expect(s.connectedAccounts.get('github')).toBeUndefined();
    expect(logs.some((l) => /not deleted: no client secret/.test(l))).toBe(true);
  });

  it('a new connection whose token GitHub refuses when checked reads as needing a reconnect, told once', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, told } = hopper(github, s, clock, { whoIs: askGitHub(github) });

    const signIn = github.mint('octo-user');
    github.tokens.delete(signIn.accessToken); // GitHub refuses it (401)
    await service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'device' });

    expect((await service.status())[0]).toMatchObject({ state: 'expired', account: 'octo-user', error: expect.stringMatching(/^reconnect needed: GitHub refused the new connection's token/) });
    expect(service.expired('github')).toBe(true);
    expect(told).toEqual([expect.stringMatching(/^octo-user: reconnect needed/)]);
    await expect(service.token('github')).rejects.toThrow(/Connect GitHub again/);
    expect(told).toHaveLength(1);
  });

  it('a connection sealed under another key reads unreadable and says to give the key back, never to connect again', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const oldKey = randomBytes(32).toString('hex');
    const s = store(url, clock);
    const first = hopper(github, s, clock, { box: createTokenBox(oldKey) });
    await connect(first.service, s);
    const kept = { accessToken: await first.service.token('github') }; // the row holds it sealed
    first.service.stop();

    const other = hopper(github, store(url, clock), clock, { box: createTokenBox(randomBytes(32).toString('hex')) });
    const status = (await other.service.status())[0]!;
    expect(status).toMatchObject({ state: 'unreadable', account: 'octo-user' });
    const error = (status as { error: string }).error;
    expect(error).toMatch(/HOPPER_TOKEN_KEY_PREVIOUS/);
    expect(error).not.toMatch(/connect GitHub again/i);
    expect(other.service.expired('github')).toBe(false);
    expect(other.told).toEqual([]);
    expect(github.revoked).toEqual([]);
    expect(github.tokens.has(kept.accessToken)).toBe(true);
  });

  it('the old key given as HOPPER_TOKEN_KEY_PREVIOUS opens it, and the next look seals it under the new key', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const oldKey = randomBytes(32).toString('hex');
    const newKey = randomBytes(32).toString('hex');
    const s = store(url, clock);
    const first = hopper(github, s, clock, { box: createTokenBox(oldKey) });
    await connect(first.service, s);
    const kept = { accessToken: await first.service.token('github') }; // the row holds it sealed
    first.service.stop();

    const rotated = hopper(github, store(url, clock), clock, { box: createTokenBox(newKey, [oldKey]) });
    expect((await rotated.service.status())[0]).toMatchObject({ state: 'connected' });
    expect(await rotated.service.token('github')).toBe(kept.accessToken);
    await rotated.service.renewDue();

    const newOnly = hopper(github, store(url, clock), clock, { box: createTokenBox(newKey) });
    expect(await newOnly.service.token('github')).toBe(kept.accessToken);
    expect(github.revoked).toEqual([]);
  });
});
