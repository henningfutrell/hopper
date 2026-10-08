// The connection is kept alive by the hopper alone (issue #441). GitHub App user tokens expire after 8
// hours; the refresh token that comes with them trades for a new pair once, and GitHub then refuses both
// the refresh token and the access token it came with. The renewer renews ahead of expiry with nothing
// asking, at start too; a renewal is atomic across processes on one database; only a refresh token GitHub
// itself refuses, with no newer pair stored, ends the sign-in. Real Postgres (two connections to one user
// schema are two processes), the real renewal over HTTP to a fake GitHub on loopback, a fake clock.
//
// Feature: the GitHub connection renews itself
//   Scenario: the scheduler renews a token near its expiry, nothing asking
//   Scenario: a hopper that was down past the 8 hours renews at its start
//   Scenario: two processes renew at once — exactly one calls GitHub, both end with the new pair
//   Scenario: the new pair is stored the moment GitHub answers, before anything else runs
//   Scenario: bad_refresh_token after another process rotated recovers with the newer pair
//   Scenario: a real revocation ends the connection, told once
//   Scenario: a 5xx or a network error ends nothing; it is tried again with backoff
//   Scenario: a web flow grant without the client secret is not sent, and ends nothing
//   Scenario: the tokens are sealed at rest; a fresh process with the same key carries on
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccount, UserStore } from '../../src/domain/ports.ts';
import { createConnectedAccounts, RETRY_MS, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { renewal } from '../../src/connected-accounts/renewal.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const EIGHT_HOURS_S = 8 * 3600;
const H = 3600_000;
const T0 = '2026-10-08T10:00:00.000Z';
const temp = useTempStore();
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function forge(clientSecret?: string): Promise<FakeForge> {
  const f = await createFakeGitHub({ clientId: 'gh-client-id', tokenLifetimeS: EIGHT_HOURS_S, ...(clientSecret ? { clientSecret } : {}) });
  cleanups.push(() => f.close());
  return f;
}

function store(url: string, clock: ReturnType<typeof fixedClock>): UserStore {
  const s = temp.open(url, clock);
  cleanups.push(() => s.close());
  return s;
}

/** One process's connected accounts over its own connection to the user schema. */
function process_(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>, o: Partial<ConnectedAccountsOptions> & { secret?: string } = {}) {
  const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
  const told: string[] = [];
  const renewed: string[] = [];
  const logs: string[] = [];
  const service = createConnectedAccounts({
    store: s, apps, clock,
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    whoIs: async () => ({ subject: '1', account: 'octo-user' }),
    installations: async () => [],
    refresh: (p, refresh, grantedBy) => renewal(apps[p], () => o.secret)(refresh, grantedBy),
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    onRenewed: (p) => { renewed.push(p); },
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, told, renewed, logs };
}

/** The account connected as the device flow grants it, at `clock`'s time, valid 8 hours. */
function connected(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>, web = false): ConnectedAccount {
  const pair = github.mint('octo-user', web);
  const now = clock.now().getTime();
  const a: ConnectedAccount = {
    provider: 'github', account: 'octo-user', subject: '1', accessToken: pair.accessToken, refreshToken: pair.refreshToken,
    expiresAt: new Date(now + EIGHT_HOURS_S * 1000).toISOString(), refreshTokenExpiresAt: new Date(now + 180 * 24 * H).toISOString(),
    connectedAt: new Date(now).toISOString(), grantedBy: web ? 'web' : 'device',
  };
  s.connectedAccounts.put(a);
  return a;
}

const refreshes = (github: FakeForge) => github.requests.filter((r) => r.path === '/login/oauth/access_token' && r.body.grant_type === 'refresh_token');

describe('the renewer (#441)', () => {
  it('renews a token near its expiry with nothing asking, and keeps the new pair', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const first = connected(github, s, clock);
    const { service, renewed } = process_(github, s, clock);

    await service.renewDue();
    expect(refreshes(github)).toHaveLength(0); // 8 hours left: not due

    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    await service.renewDue();
    expect(refreshes(github)).toHaveLength(1);
    expect(renewed).toEqual(['github']);
    const kept = s.connectedAccounts.get('github')!;
    expect(kept.accessToken).not.toBe(first.accessToken);
    expect(github.tokens.has(kept.accessToken)).toBe(true);
    expect(github.tokens.has(first.accessToken)).toBe(false); // GitHub refuses the old one now
    expect(kept.expiresAt).not.toBe(first.expiresAt); // GitHub's `expires_in`, from the real time of its answer
    expect(kept.grantedBy).toBe('device');
    expect((await service.status())[0]).toMatchObject({ state: 'connected', account: 'octo-user' });
  });

  it('a hopper down past the 8 hours renews at its start, with the stored refresh token', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    connected(github, store(url, clock), clock);

    clock.set(new Date(Date.parse(T0) + 10 * H).toISOString());
    const { service } = process_(github, store(url, clock), clock);
    service.start();
    await service.renewDue(); // the look start() began
    expect(refreshes(github)).toHaveLength(1);
    expect((await service.status())[0]).toMatchObject({ state: 'connected' });
    expect(github.tokens.has(await service.token('github'))).toBe(true);
  });

  it('two processes renewing at once: exactly one calls GitHub, both end with the new pair', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const a = store(url, clock);
    const b = store(url, clock);
    connected(github, a, clock);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const pa = process_(github, a, clock);
    const pb = process_(github, b, clock);

    const [ta, tb] = await Promise.all([pa.service.token('github'), pb.service.token('github')]);
    expect(refreshes(github)).toHaveLength(1);
    expect(ta).toBe(tb);
    expect(github.tokens.has(ta)).toBe(true);
    expect(a.connectedAccounts.get('github')).toEqual(b.connectedAccounts.get('github'));
    expect(pa.told).toEqual([]);
    expect(pb.told).toEqual([]);
  });

  it('stores the new pair the moment GitHub answers: nothing runs between the answer and the write', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const s = store(url, clock);
    const first = connected(github, s, clock);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
    let seenAfterAnswer: ConnectedAccount | undefined;
    const { service } = process_(github, s, clock, {
      // Whatever runs after GitHub answered — a crash, a stop — runs after this macrotask at the earliest.
      refresh: async (p, refresh, by) => {
        const g = await renewal(apps[p], () => undefined)(refresh, by);
        setImmediate(() => { seenAfterAnswer = store(url, clock).connectedAccounts.get('github'); });
        return g;
      },
    });
    const token = await service.token('github');
    await new Promise((resolve) => setImmediate(resolve));
    // A fresh process reading at the first moment anything else could run finds the new pair, not the spent one.
    expect(seenAfterAnswer?.accessToken).toBe(token);
    expect(seenAfterAnswer?.refreshToken).not.toBe(first.refreshToken);
    expect(github.refreshTokens.has(seenAfterAnswer!.refreshToken!)).toBe(true);
  });

  it('bad_refresh_token after another process rotated the pair: re-reads, uses the newer pair, and ends nothing', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const s = store(url, clock);
    connected(github, s, clock);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
    // An older hopper beside this one, which takes no lock, renews between this one's re-read and its call.
    const older = store(url, clock);
    const olderRenews = async () => {
      const row = older.connectedAccounts.get('github')!;
      const g = await renewal(apps.github, () => undefined)(row.refreshToken!, 'device');
      older.connectedAccounts.put({ ...row, accessToken: g.accessToken, refreshToken: g.refreshToken!, expiresAt: g.expiresAt!.toISOString() });
    };
    let raced = false;
    const { service, told } = process_(github, s, clock, {
      refresh: async (p, refresh, by) => {
        if (!raced) { raced = true; await olderRenews(); }
        return renewal(apps[p], () => undefined)(refresh, by);
      },
    });
    const token = await service.token('github');
    expect(told).toEqual([]);
    expect(token).toBe(older.connectedAccounts.get('github')!.accessToken);
    expect(github.tokens.has(token)).toBe(true);
    expect((await service.status())[0]).toMatchObject({ state: 'connected' });
  });

  it('a real revocation ends the connection: expired, told once, never connected', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    connected(github, s, clock);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const { service, told } = process_(github, s, clock);
    github.refreshTokens.clear(); // the user removed the app's authorization

    await service.renewDue();
    expect(told).toEqual([expect.stringMatching(/^octo-user: GitHub refused the refresh token \(bad_refresh_token\)/)]);
    expect((await service.status())[0]).toMatchObject({ state: 'expired', error: expect.stringMatching(/bad_refresh_token/) });
    expect(service.account('github')).toBeUndefined();
    expect(service.ended('github')).toBe('GitHub\'s sign-in expired: Sources → Connect GitHub again');
    await service.renewDue();
    expect(told).toHaveLength(1);
  });

  it('a 5xx or a network error ends nothing: shown on the account, tried again with backoff, then renewed', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const first = connected(github, s, clock);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const { service, told } = process_(github, s, clock);

    github.refreshDown = 502;
    await service.renewDue();
    expect(refreshes(github)).toHaveLength(1);
    expect(told).toEqual([]);
    expect((await service.status())[0]).toMatchObject({ state: 'connected', renewal: expect.stringMatching(/could not renew/) });
    expect(await service.token('github')).toBe(first.accessToken); // still good for half an hour

    await service.renewDue(); // before the retry is due: not asked again
    expect(refreshes(github)).toHaveLength(1);

    // Past its expiry and GitHub unreachable: no token to give, the sign-in is not ended.
    clock.set(new Date(Date.parse(T0) + 8.5 * H).toISOString());
    const down = createConnectedAccounts({ ...optionsOf(github, s, clock), refresh: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); } });
    await expect(down.token('github')).rejects.toThrow(/could not renew the token: connect ECONNREFUSED/);
    expect((await down.status())[0]).toMatchObject({ state: 'connected', renewal: expect.stringMatching(/ECONNREFUSED/) });
    expect(down.ended('github')).toBeUndefined();

    github.refreshDown = undefined;
    clock.set(new Date(clock.now().getTime() + RETRY_MS[0]!).toISOString());
    await service.renewDue();
    expect(refreshes(github)).toHaveLength(2);
    expect((await service.status())[0]).not.toHaveProperty('renewal');
    expect(told).toEqual([]);
  });

  it('a web flow grant without the client secret is not sent, ends nothing, and renews once the secret is given', async () => {
    const github = await forge('gh-secret');
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    connected(github, s, clock, true);
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const without = process_(github, s, clock);

    await without.service.renewDue();
    expect(refreshes(github)).toHaveLength(0);
    expect(without.told).toEqual([]);
    expect((await without.service.status())[0]).toMatchObject({ state: 'connected', renewal: expect.stringMatching(/HOPPER_GITHUB_CLIENT_SECRET/) });

    const withSecret = process_(github, s, clock, { secret: 'gh-secret' });
    await withSecret.service.renewDue();
    expect(refreshes(github)).toHaveLength(1);
    expect(refreshes(github)[0]!.body).toMatchObject({ client_secret: 'gh-secret' });
    expect(s.connectedAccounts.get('github')!.grantedBy).toBe('web');
  });

  it('seals the tokens at rest; a fresh process with the same key carries on, another key reads as unreadable', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const s = store(url, clock);
    const first = connected(github, s, clock); // kept in clear, as before #441
    const key = randomBytes(32).toString('hex');
    const { service } = process_(github, s, clock, { box: createTokenBox(key) });

    await service.renewDue(); // the look seals what is clear
    const raw = s.connectedAccounts.get('github')!;
    expect(JSON.stringify(raw)).not.toMatch(/gh[or]_/);
    expect(await service.token('github')).toBe(first.accessToken);

    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const fresh = process_(github, store(url, clock), clock, { box: createTokenBox(key) });
    const renewed = await fresh.service.token('github');
    expect(github.tokens.has(renewed)).toBe(true);
    expect(JSON.stringify(s.connectedAccounts.get('github'))).not.toMatch(/gh[or]_/);

    const other = process_(github, store(url, clock), clock, { box: createTokenBox(randomBytes(32).toString('hex')) });
    expect((await other.service.status())[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/another HOPPER_TOKEN_KEY/) });
    await expect(other.service.token('github')).rejects.toThrow(/another HOPPER_TOKEN_KEY/);
    expect(other.told).toEqual([]);
  });
});

function optionsOf(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>): ConnectedAccountsOptions {
  return {
    store: s, apps: hopperApps({ github: { clientId: 'gh-client-id', url: github.url } }), clock,
    logger: { info: () => undefined, warn: () => undefined },
    whoIs: async () => ({ subject: '1', account: 'octo-user' }), installations: async () => [],
    refresh: async () => { throw new Error('unused'); },
  };
}
