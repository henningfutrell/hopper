// Fixes for GitHub token revocation issues (issue #597): never call POST /credentials/revoke during routine
// operations, check new connections, handle incorrect_client_credentials correctly when sent without a client
// secret. Real Postgres, fake GitHub on loopback.
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { renewal } from '../../src/connected-accounts/renewal.ts';
import { tokenDeletion } from '../../src/connected-accounts/revocation.ts';
import type { UserStore } from '../../src/domain/ports.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { accountOf, systemOf } from '../support/system-secrets.ts';
import { waitFor } from '../support/wait.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const EIGHT_HOURS_S = 8 * 3600;
const T0 = '2026-10-09T10:00:00.000Z';
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
  const told: string[] = [];
  const service = createConnectedAccounts({
    store: s, apps, clock,
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    whoIs: async (_, token) => {
      if (!github.tokens.has(token)) throw new Error('Bad credentials');
      return { subject: '1', account: 'octo-user' };
    },
    installations: async () => [],
    refresh: (p, refresh, grantedBy) => renewal(apps[p], () => undefined)(refresh, grantedBy),
    deleteToken: (p, accessToken) => tokenDeletion(apps[p], undefined)(accessToken),
    hasClientSecret: () => false,
    flows: { github: approvedAs(github, 'octo-user', clock) },
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    secrets: systemOf(s),
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, logs, told };
}

async function connect(service: ReturnType<typeof hopper>['service'], s: UserStore) {
  const before = accountOf(s)?.accessToken;
  await service.connect('github');
  await waitFor(async () => { const now = accountOf(s); return now !== undefined && now.accessToken !== before; }, { what: 'github connected' });
  return accountOf(s)!;
}

describe('token revocation fixes (#597)', () => {
  it('never calls POST /credentials/revoke during connect', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service } = hopper(github, s, clock);

    await connect(service, s);
    await connect(service, s); // reconnect

    // The revoke endpoint was never called
    expect(github.revoked).toEqual([]);
  });

  it('checks new connection with GET /user and marks it reconnect-needed if GitHub refuses', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);

    let refuseWhoIs = false;
    const apps = hopperApps({ github: { clientId: 'gh-client-id', url: github.url } });
    const logs: string[] = [];
    const told: string[] = [];
    const service = createConnectedAccounts({
      store: s, apps, clock, secrets: systemOf(s),
      logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
      whoIs: async (_, token) => {
        if (refuseWhoIs || !github.tokens.has(token)) throw new Error('Bad credentials');
        return { subject: '1', account: 'octo-user' };
      },
      installations: async () => [],
      refresh: (p, refresh, grantedBy) => renewal(apps[p], () => undefined)(refresh, grantedBy),
      deleteToken: (p, accessToken) => tokenDeletion(apps[p], undefined)(accessToken),
      hasClientSecret: () => false,
      flows: { github: approvedAs(github, 'octo-user', clock) },
      onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
    });
    cleanups.push(() => service.stop());

    // Connect normally first
    await connect(service, s);
    const status1 = (await service.status())[0]!;
    expect(status1).toMatchObject({ state: 'connected', account: 'octo-user' });

    // A sign-in with GitHub, with no healthy connection to keep (issue #647), hands over a token GitHub refuses: it is
    // kept as ended, not as live.
    await service.disconnect('github');
    refuseWhoIs = true;
    const signIn = github.mint('octo-user');
    await service.adopt({ provider: 'github', subject: '1', account: 'octo-user', accessToken: signIn.accessToken, refreshToken: signIn.refreshToken, grantedBy: 'web' });
    expect(s.connectedAccounts.get('github')?.ended).toMatch(/refused the new token/);
    expect(service.expired('github')).toBe(true);

    const status2 = (await service.status())[0]!;
    expect(status2.state).toBe('expired');
    expect(logs.some((l) => l.includes('refused the new token'))).toBe(true);
    expect(told.some((s) => s.includes('refused the new token'))).toBe(true);
  });

  it('treats incorrect_client_credentials without client secret as token end, not app misconfiguration', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    // GitHub answering a device-flow refresh (no client secret) with incorrect_client_credentials, as it did
    // after the grant was reported through the credential revocation API.
    const refuse = async (): Promise<Grant> => { throw Object.assign(new Error('incorrect_client_credentials'), { error: 'incorrect_client_credentials' }); };
    const { service, logs, told } = hopper(github, s, clock, { refresh: refuse });
    await connect(service, s);

    clock.set(new Date(Date.parse(T0) + 7.5 * 3600_000).toISOString());
    await expect(service.token('github')).rejects.toThrow(/sign-in expired/);

    expect(service.expired('github')).toBe(true);
    expect(told.some((t) => t.includes('incorrect_client_credentials'))).toBe(true);
    expect(logs.every((l) => !l.includes('check HOPPER_GITHUB_CLIENT_ID'))).toBe(true);
  });

  it('with a client secret, incorrect_client_credentials stays a setup problem and does not end the connection', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const refuse = async (): Promise<Grant> => { throw Object.assign(new Error('incorrect_client_credentials'), { error: 'incorrect_client_credentials' }); };
    const { service } = hopper(github, s, clock, { refresh: refuse, hasClientSecret: () => true });
    await connect(service, s);

    clock.set(new Date(Date.parse(T0) + 7.5 * 3600_000).toISOString());
    await service.token('github').catch(() => undefined); // the old token still lives; the renewal is retried
    expect(service.expired('github')).toBe(false);
  });

  it('never deletes tokens when no client secret is provided', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service } = hopper(github, s, clock);

    const first = await connect(service, s);
    await service.disconnect('github');

    // The token is still alive at GitHub because we didn't have a client secret to delete it
    expect(github.tokens.has(first.accessToken)).toBe(true);
    expect(github.revoked).toEqual([]);
  });
});
