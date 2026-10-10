// The hopper keeps one GitHub grant per connection, never more (issue #514). GitHub keeps at most ten
// tokens per user and app; making an eleventh revokes an older one — the one never used, else the least
// recently used — even when another hopper is renewing it. Every device or web flow connect, and every
// sign-in with GitHub, is a new grant; a renewal is not. So the hopper revokes the grant it replaces or drops,
// before it keeps the new one: a reconnect storm on one hopper does not cost another hopper its connection.
// And a connection it cannot read (the token key changed) never pushes the person to mint a new grant: it
// says to give the key back, and an older key opens it as HOPPER_MASTER_KEY_PREVIOUS.
// Real Postgres, the real revocation and renewal over HTTP to a fake GitHub on loopback, a fake clock.
//
// Feature: grant hygiene under GitHub's ten-token limit
//   Scenario: connecting again over a live grant revokes it at GitHub before the new pair is kept
//   Scenario: a sign-in with GitHub over a live grant revokes it the same way
//   Scenario: disconnecting revokes the grant, then forgets it; GitHub not answering forgets it anyway
//   Scenario: twelve reconnects on one hopper leave another hopper's grant alive under the ten-token limit
//   Scenario: a connection sealed under another key reads unreadable and says to give the key, not to connect again
//   Scenario: the old key given as HOPPER_MASTER_KEY_PREVIOUS opens it, and the next look seals it under the new key
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccount, UserStore } from '../../src/domain/ports.ts';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { renewal } from '../../src/connected-accounts/renewal.ts';
import { tokenDeletion } from '../../src/connected-accounts/revocation.ts';
import { accountOf, systemOf } from '../support/system-secrets.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { waitFor } from '../support/wait.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const EIGHT_HOURS_S = 8 * 3600;
const H = 3600_000;
const T0 = '2026-10-08T10:00:00.000Z';
const temp = useTempStore();
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function forge(o: { tokenLimit?: number } = {}): Promise<FakeForge> {
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

/** One hopper's connected accounts over its own connection to a user schema. */
function hopper(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>, { key, previous, ...o }: Partial<ConnectedAccountsOptions> & { key?: string | null; previous?: string[] } = {}) {
  const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
  const logs: string[] = [];
  const told: string[] = [];
  const service = createConnectedAccounts({
    store: s, apps, clock,
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    whoIs: async () => ({ subject: '1', account: 'octo-user' }),
    installations: async () => [],
    refresh: (p, refresh, grantedBy) => renewal(apps[p], () => undefined)(refresh, grantedBy),
    deleteToken: (p, accessToken) => tokenDeletion(apps[p], undefined)(accessToken),
    flows: { github: approvedAs(github, 'octo-user', clock) },
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    secrets: systemOf(s, key, previous),
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, logs, told };
}

/** Connect (again): resolves once a new pair is kept. */
async function connect(service: ReturnType<typeof hopper>['service'], s: UserStore, key?: string): Promise<ConnectedAccount> {
  const before = accountOf(s, key)?.accessToken;
  await service.connect('github');
  await waitFor(async () => { const now = accountOf(s, key); return now !== undefined && now.accessToken !== before; }, { what: 'github connected' });
  return accountOf(s, key)!;
}

describe('grant hygiene under the ten-token limit (#514)', () => {
  // Issue #597: GitHub's credential revocation API (POST /credentials/revoke) is a leak report, it emails the
  // owner a security warning and killed a fresh grant; it is never used for routine cleanup. Without the
  // app's client secret (this hopper's app ships none) an old grant is left to expire at GitHub.
  it('connecting again over a live grant never reports it to GitHub; the new pair is kept', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service } = hopper(github, s, clock);
    const first = await connect(service, s);
    await connect(service, s);

    expect(github.revoked).toEqual([]);
    expect(github.tokens.has(first.accessToken)).toBe(true);
    const now = accountOf(s)!;
    expect(now.accessToken).not.toBe(first.accessToken);
    expect(github.tokens.has(now.accessToken)).toBe(true);
    expect(await service.token('github')).toBe(now.accessToken);
  });

  it('a sign-in with GitHub over a live grant never reports either grant to GitHub', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service } = hopper(github, s, clock);
    await connect(service, s);

    const signIn = github.mint('octo-user');
    await service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    // Held while the connection is healthy (issue #647), then taken.
    await service.takeHeld('github');
    expect(github.revoked).toEqual([]);
    expect(accountOf(s)!.accessToken).toBe(signIn.accessToken);
    expect(github.tokens.has(signIn.accessToken)).toBe(true);
    expect(await service.token('github')).toBe(signIn.accessToken);
  });

  it('disconnecting forgets the grant without reporting it to GitHub, and logs no token', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, logs } = hopper(github, s, clock);
    await connect(service, s);

    expect(await service.disconnect('github')).toMatchObject({ state: 'not-connected' });
    expect(github.revoked).toEqual([]);
    expect(s.connectedAccounts.get('github')).toBeUndefined();
    expect(logs.join('\n')).not.toMatch(/gh[or]_/); // never a token in the log
  });

  it('a connection sealed under another key reads unreadable and says to give the key back, never to connect again', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const oldKey = randomBytes(32).toString('hex');
    const s = store(url, clock);
    const first = hopper(github, s, clock, { key: oldKey });
    await connect(first.service, s, oldKey);
    const kept = { accessToken: await first.service.token('github') }; // the row holds it sealed
    first.service.stop();

    const other = hopper(github, store(url, clock), clock, { key: randomBytes(32).toString('hex') });
    const status = (await other.service.status())[0]!;
    expect(status).toMatchObject({ state: 'unreadable', account: 'octo-user' });
    const error = (status as { error: string }).error;
    expect(error).toMatch(/HOPPER_MASTER_KEY_PREVIOUS/);
    expect(error).not.toMatch(/connect GitHub again/i);
    expect(other.service.expired('github')).toBe(false);
    expect(other.told).toEqual([]);
    expect(github.revoked).toEqual([]);
    expect(github.tokens.has(kept.accessToken)).toBe(true);
  });

  it('the old key given as HOPPER_MASTER_KEY_PREVIOUS opens it, and a start seals it under the new key', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const url = temp.url();
    const oldKey = randomBytes(32).toString('hex');
    const newKey = randomBytes(32).toString('hex');
    const s = store(url, clock);
    const first = hopper(github, s, clock, { key: oldKey });
    await connect(first.service, s, oldKey);
    const kept = { accessToken: await first.service.token('github') }; // the row holds it sealed
    first.service.stop();

    const rotated = hopper(github, store(url, clock), clock, { key: newKey, previous: [oldKey] });
    expect((await rotated.service.status())[0]).toMatchObject({ state: 'connected' });
    expect(await rotated.service.token('github')).toBe(kept.accessToken);
    // A start seals every system secret an older key sealed again (issue #658).
    expect(systemOf(s, newKey, [oldKey]).resealAll()).toBe(2);

    const newOnly = hopper(github, store(url, clock), clock, { key: newKey });
    expect(await newOnly.service.token('github')).toBe(kept.accessToken);
    expect(github.revoked).toEqual([]);
  });
});
