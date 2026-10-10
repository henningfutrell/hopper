// The health of a GitHub connection (issue #647): the owner sees what the connection is doing and is told when
// GitHub refuses it, and a sign-in never quietly replaces a connection that works. Real Postgres, fake GitHub on
// loopback; the clock is set by the test.
//
// Feature: the owner sees the connection's health
//   Scenario: each renewal is recorded, with no token
//   Scenario: each failed renewal is recorded, with its error code
//   Scenario: GitHub refusing the token it just renewed (a 401) ends the connection: reconnect needed
//   Scenario: a 401 skips the renewal backoff at most once a minute
//   Scenario: the status says how and when the connection was made, renewed, will renew, and its last error
//   Scenario: a sign-in while the connection is healthy is held until the person confirms it
//   Scenario: a sign-in while the connection is not healthy replaces it at once, and running jobs get the token
//   Scenario: a token sealed under a key the runtime does not give says which key is missing, at start
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { renewal } from '../../src/connected-accounts/renewal.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { waitFor } from '../support/wait.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const EIGHT_HOURS_S = 8 * 3600;
const T0 = '2026-10-09T10:00:00.000Z';
const MINUTE = 60_000;
const temp = useTempStore();
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function forge(): Promise<FakeForge> {
  const f = await createFakeGitHub({ clientId: 'gh-client-id', tokenLifetimeS: EIGHT_HOURS_S });
  cleanups.push(() => f.close());
  return f;
}

function store(url: string, clock: ReturnType<typeof fixedClock>): UserStore {
  const s = temp.open(url, clock);
  cleanups.push(() => s.close());
  return s;
}

const approvedAs = (github: FakeForge, login: string, clock: ReturnType<typeof fixedClock>): DeviceFlow => ({
  start: async () => ({
    userCode: 'TEST-CODE', verificationUri: `${github.url}/login/device`, expiresAt: new Date(Date.now() + 900_000),
    grant: async (): Promise<Grant> => {
      const pair = github.mint(login);
      const now = clock.now().getTime();
      return { ...pair, grantedBy: 'device', expiresAt: new Date(now + EIGHT_HOURS_S * 1000), refreshTokenExpiresAt: new Date(now + 180 * 24 * 3600_000) };
    },
  }),
});

function hopper(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>, o: Partial<ConnectedAccountsOptions> = {}) {
  const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
  const logs: string[] = [];
  const renewed: unknown[] = [];
  const failures: unknown[] = [];
  const handed: string[] = [];
  const deleted: string[] = [];
  const service = createConnectedAccounts({
    store: s, apps, clock,
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    whoIs: async (_, token) => {
      if (!github.tokens.has(token)) throw new Error('Bad credentials');
      return { subject: '1', account: 'octo-user' };
    },
    installations: async () => [],
    refresh: (p, refresh, grantedBy) => renewal(apps[p], () => undefined)(refresh, grantedBy),
    deleteToken: async (_p, accessToken) => { deleted.push(accessToken); },
    hasClientSecret: () => false,
    flows: { github: approvedAs(github, 'octo-user', clock) },
    onRenewed: (_p, r) => { renewed.push(r); },
    onRenewalFailed: (_p, r) => { failures.push(r); },
    onToken: (p) => { handed.push(p); },
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, logs, renewed, failures, handed, deleted };
}

async function connect(service: ReturnType<typeof hopper>['service'], s: UserStore) {
  const before = s.connectedAccounts.get('github')?.accessToken;
  await service.connect('github');
  await waitFor(async () => { const now = s.connectedAccounts.get('github'); return now !== undefined && now.accessToken !== before; }, { what: 'github connected' });
  return s.connectedAccounts.get('github')!;
}

const github = async (service: ReturnType<typeof hopper>['service']) => (await service.status())[0]!;
const later = (clock: ReturnType<typeof fixedClock>, ms: number) => clock.set(new Date(clock.now().getTime() + ms).toISOString());

describe('the connection\'s renewals are recorded (#647)', () => {
  it('records each renewal with its new expiry, and no token', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    await connect(h.service, s);

    later(clock, 7.5 * 3600_000);
    await h.service.renewDue();
    expect(h.renewed).toHaveLength(1);
    expect(h.renewed[0]).toMatchObject({ account: 'octo-user', expiresAt: expect.any(String) });
    expect(JSON.stringify(h.renewed)).not.toMatch(/gh[or]_/);
    expect(s.connectedAccounts.get('github')?.renewedAt).toBe(clock.now().toISOString());
  });

  it('records each failed renewal with its error code', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const refuse = async (): Promise<Grant> => { throw Object.assign(new Error('slow_down'), { error: 'slow_down' }); };
    const h = hopper(gh, s, clock, { refresh: refuse });
    await connect(h.service, s);

    later(clock, 7.5 * 3600_000);
    await h.service.renewDue();
    expect(h.failures).toEqual([{ account: 'octo-user', code: 'slow_down' }]);
  });
});

describe('GitHub refusing the connection reads as reconnect needed (#647)', () => {
  it('a 401 on the token just renewed ends the connection', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    const first = await connect(h.service, s);

    const renewed = await h.service.renew('github', first.accessToken);
    expect(renewed).not.toBe(first.accessToken);
    later(clock, 5_000);
    await expect(h.service.renew('github', renewed)).rejects.toThrow(/sign-in expired/);
    expect(await github(h.service)).toMatchObject({ state: 'expired', error: expect.stringMatching(/refused the token it renewed/) });
  });

  it('a 401 skips the renewal backoff at most once a minute', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    let calls = 0;
    const down = async (): Promise<Grant> => { calls++; throw Object.assign(new Error('GitHub answered 503'), { status: 503 }); };
    const h = hopper(gh, s, clock, { refresh: down });
    const first = await connect(h.service, s);

    const refused = () => h.service.renew('github', first.accessToken).catch(() => undefined);
    await refused(); // t 0: in trouble now, tried again at 30 s
    expect(calls).toBe(1);
    later(clock, 1_000);
    await refused(); // t 1: skips the backoff (tried again at 61 s)
    expect(calls).toBe(2);
    later(clock, 1_000);
    await refused(); // t 2
    later(clock, 43_000);
    await refused(); // t 45: still in its backoff, and the last skip was under a minute ago
    expect(calls).toBe(2);
    later(clock, 16_500);
    await refused(); // t 61.5: the backoff is over: tried again (tried again at 181.5 s)
    expect(calls).toBe(3);
    later(clock, 500);
    await refused(); // t 62: in its backoff, the last skip a minute ago: skips it again
    expect(calls).toBe(4);
    later(clock, 1_000);
    await refused(); // t 63
    expect(calls).toBe(4);
  });
});

describe('the status says how the connection was made and how it renews (#647)', () => {
  it('names the flow, the last and next renewal, and the last error', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    let fail = false;
    const apps = hopperApps({ github: { clientId: 'gh-client-id', url: gh.url } });
    const flaky = (p: 'github', refresh: string, grantedBy: Grant['grantedBy']) => {
      if (fail) return Promise.reject(Object.assign(new Error('GitHub answered 502'), { status: 502 }));
      return renewal(apps[p], () => undefined)(refresh, grantedBy);
    };
    const h = hopper(gh, s, clock, { refresh: flaky });
    await connect(h.service, s);
    const connected = await github(h.service);
    expect(connected).toMatchObject({ state: 'connected', connectedAt: T0, connectedBy: 'sources', grantedBy: 'device' });
    if (connected.state !== 'connected') throw new Error('not connected');
    expect(connected.renewedAt).toBeUndefined();
    expect(connected.lastError).toBeUndefined();
    // Renewed an hour before its expiry.
    expect(connected.nextRenewalAt).toBe(new Date(Date.parse(T0) + 7 * 3600_000).toISOString());

    later(clock, 7.5 * 3600_000);
    await h.service.renewDue();
    const renewedAt = clock.now().toISOString();
    const current = s.connectedAccounts.get('github')!.accessToken;
    fail = true;
    later(clock, 3 * 3600_000);
    await h.service.renew('github', current).catch(() => undefined);
    const troubled = await github(h.service);
    if (troubled.state !== 'connected') throw new Error('not connected');
    expect(troubled.renewedAt).toBe(renewedAt);
    expect(troubled.lastError).toMatchObject({ at: clock.now().toISOString(), error: expect.stringMatching(/502/) });
    // Tried again after the first backoff, 30 s.
    expect(troubled.nextRenewalAt).toBe(new Date(clock.now().getTime() + 30_000).toISOString());
    expect(JSON.stringify(troubled)).not.toMatch(/gh[or]_/);
  });
});

describe('a sign-in never quietly replaces a healthy connection (#647)', () => {
  it('holds the sign-in\'s grant until the person confirms it, then hands it to running jobs', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    const first = await connect(h.service, s);
    h.handed.length = 0;

    const signIn = gh.mint('octo-user', true);
    await h.service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    expect(s.connectedAccounts.get('github')!.accessToken).toBe(first.accessToken);
    expect(h.handed).toEqual([]);
    expect(await github(h.service)).toMatchObject({ state: 'connected', held: { account: 'octo-user', at: T0 } });
    expect(h.logs.some((l) => /held/.test(l))).toBe(true);

    await h.service.takeHeld('github');
    const now = s.connectedAccounts.get('github')!;
    expect(now.accessToken).toBe(signIn.accessToken);
    expect(now.connectedBy).toBe('sign-in');
    expect(h.handed).toEqual(['github']);
    expect(await github(h.service)).not.toHaveProperty('held');
  });

  it('dropping the held grant keeps the connection and deletes the held token', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    const first = await connect(h.service, s);

    const signIn = gh.mint('octo-user', true);
    await h.service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    await h.service.dropHeld('github');
    expect(s.connectedAccounts.get('github')!.accessToken).toBe(first.accessToken);
    expect(h.deleted).toEqual([signIn.accessToken]);
    expect(await github(h.service)).not.toHaveProperty('held');
  });

  it('a sign-in whose token GitHub refuses leaves the healthy connection as it is', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    const first = await connect(h.service, s);

    await h.service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: 'gho_refused', grantedBy: 'web' });
    expect(s.connectedAccounts.get('github')!.accessToken).toBe(first.accessToken);
    expect(await github(h.service)).toMatchObject({ state: 'connected' });
    expect(await github(h.service)).not.toHaveProperty('held');
  });

  it('a sign-in while the connection is not healthy replaces it at once, and running jobs get the token', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    const first = await connect(h.service, s);
    gh.refreshTokens.clear();
    await h.service.renew('github', first.accessToken).catch(() => undefined); // GitHub refuses the refresh token: ended
    expect((await github(h.service)).state).toBe('expired');
    h.handed.length = 0;

    const signIn = gh.mint('octo-user', true);
    await h.service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    expect(s.connectedAccounts.get('github')!.accessToken).toBe(signIn.accessToken);
    expect(h.handed).toEqual(['github']);
    expect((await github(h.service)).state).toBe('connected');
  });

  it('connecting again from Sources is the person\'s own act: it replaces at once and hands the token on', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const h = hopper(gh, s, clock);
    const first = await connect(h.service, s);
    h.handed.length = 0;
    const second = await connect(h.service, s);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(h.handed).toEqual(['github']);
  });
});

describe('a token the runtime cannot open says which key is missing, at start (#647)', () => {
  it('names HOPPER_TOKEN_KEY when the runtime gives none', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const s = store(url, clock);
    const sealer = hopper(gh, s, clock, { box: createTokenBox(randomBytes(32).toString('hex')) });
    await connect(sealer.service, s);
    sealer.service.stop();

    const h = hopper(gh, store(url, clock), clock);
    h.service.start();
    expect(h.logs.some((l) => /start check/.test(l) && /HOPPER_TOKEN_KEY is missing/.test(l))).toBe(true);
    expect(h.logs.some((l) => /sign in/i.test(l))).toBe(false);
  });

  it('names the sealing key as missing when the runtime gives another one', async () => {
    const gh = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const s = store(url, clock);
    const sealer = hopper(gh, s, clock, { box: createTokenBox(randomBytes(32).toString('hex')) });
    await connect(sealer.service, s);
    sealer.service.stop();

    const h = hopper(gh, store(url, clock), clock, { box: createTokenBox(randomBytes(32).toString('hex')) });
    h.service.start();
    expect(h.logs.some((l) => /start check/.test(l) && /the key it was sealed under is missing/.test(l))).toBe(true);
  });
});
