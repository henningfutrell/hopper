// The hopper keeps one GitHub grant per connection, never more (issue #514). GitHub keeps at most ten
// tokens per user and app; making an eleventh revokes an older one — the one never used, else the least
// recently used — even when another hopper is renewing it. Every device or web flow connect, and every
// sign-in with GitHub, is a new grant; a renewal is not. So the hopper revokes the grant it replaces or drops,
// before it keeps the new one: a reconnect storm on one hopper does not cost another hopper its connection.
// And a connection it cannot read (the token key changed) never pushes the person to mint a new grant: it
// says to give the key back, and an older key opens it as HOPPER_TOKEN_KEY_PREVIOUS.
// Real Postgres, the real revocation and renewal over HTTP to a fake GitHub on loopback, a fake clock.
//
// Feature: grant hygiene under GitHub's ten-token limit
//   Scenario: connecting again over a live grant revokes it at GitHub before the new pair is kept
//   Scenario: a sign-in with GitHub over a live grant revokes it the same way
//   Scenario: disconnecting revokes the grant, then forgets it; GitHub not answering forgets it anyway
//   Scenario: twelve reconnects on one hopper leave another hopper's grant alive under the ten-token limit
//   Scenario: a connection sealed under another key reads unreadable and says to give the key, not to connect again
//   Scenario: the old key given as HOPPER_TOKEN_KEY_PREVIOUS opens it, and the next look seals it under the new key
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectedAccount, UserStore } from '../../src/domain/ports.ts';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { renewal } from '../../src/connected-accounts/renewal.ts';
import { revocation } from '../../src/connected-accounts/revocation.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
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
const approvedAs = (github: FakeForge, login: string): DeviceFlow => ({
  start: async () => ({
    userCode: 'WDJB-MJHT', verificationUri: `${github.url}/login/device`, expiresAt: new Date(Date.now() + 900_000),
    grant: async (): Promise<Grant> => {
      const pair = github.mint(login);
      return { ...pair, grantedBy: 'device', expiresAt: new Date(Date.now() + EIGHT_HOURS_S * 1000), refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * H) };
    },
  }),
});

/** One hopper's connected accounts over its own connection to a user schema. */
function hopper(github: FakeForge, s: UserStore, clock: ReturnType<typeof fixedClock>, o: Partial<ConnectedAccountsOptions> = {}) {
  const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
  const logs: string[] = [];
  const told: string[] = [];
  const service = createConnectedAccounts({
    store: s, apps, clock,
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    whoIs: async () => ({ subject: '1', account: 'octo-user' }),
    installations: async () => [],
    refresh: (p, refresh, grantedBy) => renewal(apps[p], () => undefined)(refresh, grantedBy),
    revoke: (p, credentials) => revocation(apps[p])(credentials),
    flows: { github: approvedAs(github, 'octo-user') },
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, logs, told };
}

/** Connect (again): resolves once a new pair is kept. */
async function connect(service: ReturnType<typeof hopper>['service'], s: UserStore): Promise<ConnectedAccount> {
  const before = s.connectedAccounts.get('github')?.accessToken;
  await service.connect('github');
  await waitFor(async () => { const now = s.connectedAccounts.get('github'); return now !== undefined && now.accessToken !== before; }, { what: 'github connected' });
  return s.connectedAccounts.get('github')!;
}

describe('grant hygiene under the ten-token limit (#514)', () => {
  it('connecting again over a live grant revokes it at GitHub before the new pair is kept', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service } = hopper(github, s, clock);
    const first = await connect(service, s);

    let storedAtRevoke: string | undefined;
    github.onRevoke = () => { storedAtRevoke = s.connectedAccounts.get('github')?.accessToken; };
    await connect(service, s);

    expect(github.revoked).toEqual([[first.accessToken, first.refreshToken]]);
    expect(storedAtRevoke).toBe(first.accessToken); // revoked while the old pair was still the stored one
    expect(github.tokens.has(first.accessToken)).toBe(false);
    expect(github.refreshTokens.has(first.refreshToken!)).toBe(false);
    const now = s.connectedAccounts.get('github')!;
    expect(github.tokens.has(now.accessToken)).toBe(true);
    expect(await service.token('github')).toBe(now.accessToken);
  });

  it('a sign-in with GitHub over a live grant revokes it the same way', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service } = hopper(github, s, clock);
    const first = await connect(service, s);

    const signIn = github.mint('octo-user');
    await service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    expect(github.revoked).toEqual([[first.accessToken, first.refreshToken]]);
    expect(s.connectedAccounts.get('github')!.accessToken).toBe(signIn.accessToken);

    // The same grant handed over again is not revoked: it is the one kept.
    await service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    expect(github.revoked).toHaveLength(1);
    expect(github.tokens.has(signIn.accessToken)).toBe(true);
  });

  it('disconnecting revokes the grant, then forgets it; GitHub not answering forgets it anyway and says so', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, logs } = hopper(github, s, clock);
    const first = await connect(service, s);

    let storedAtRevoke: ConnectedAccount | undefined;
    github.onRevoke = () => { storedAtRevoke = s.connectedAccounts.get('github'); };
    expect(await service.disconnect('github')).toMatchObject({ state: 'not-connected' });
    expect(storedAtRevoke?.accessToken).toBe(first.accessToken);
    expect(github.revoked).toEqual([[first.accessToken, first.refreshToken]]);
    expect(s.connectedAccounts.get('github')).toBeUndefined();

    const second = await connect(service, s);
    github.onRevoke = undefined;
    github.revokeDown = 500;
    expect(await service.disconnect('github')).toMatchObject({ state: 'not-connected' });
    expect(s.connectedAccounts.get('github')).toBeUndefined();
    expect(github.tokens.has(second.accessToken)).toBe(true); // still alive at GitHub: said, not hidden
    expect(logs.some((l) => /could not revoke/.test(l))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/gh[or]_/); // never a token in the log
  });

  it('twelve reconnects on one hopper leave another hopper\'s grant alive under the ten-token limit', async () => {
    const github = await forge({ tokenLimit: 10 });
    const clock = fixedClock(T0);
    // The durable hopper: its own database, connected first, its token used once and then left alone.
    const durableStore = store(temp.url(), clock);
    const durable = hopper(github, durableStore, clock);
    const kept = await connect(durable.service, durableStore);
    await fetch(`${github.url}/api/v3/user`, { headers: { authorization: `token ${kept.accessToken}` } });

    // Another hopper, on another database, connects again and again (a verify run, a person retrying).
    const busyStore = store(temp.url(), clock);
    const busy = hopper(github, busyStore, clock);
    for (let i = 0; i < 12; i++) {
      const t = (await connect(busy.service, busyStore)).accessToken;
      await fetch(`${github.url}/api/v3/user`, { headers: { authorization: `token ${t}` } });
    }

    expect(github.refreshTokens.has(kept.refreshToken!)).toBe(true);
    // Hours later the durable hopper renews as ever: its sign-in did not end.
    clock.set(new Date(Date.parse(T0) + 7.5 * H).toISOString());
    const renewed = await durable.service.token('github');
    expect(renewed).not.toBe(kept.accessToken);
    expect(github.tokens.has(renewed)).toBe(true);
    expect(durable.told).toEqual([]);
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
