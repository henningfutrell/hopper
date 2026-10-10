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
    ...o,
  });
  cleanups.push(() => service.stop());
  return { service, logs, told };
}

async function connect(service: ReturnType<typeof hopper>['service'], s: UserStore) {
  const before = s.connectedAccounts.get('github')?.accessToken;
  await service.connect('github');
  await waitFor(async () => { const now = s.connectedAccounts.get('github'); return now !== undefined && now.accessToken !== before; }, { what: 'github connected' });
  return s.connectedAccounts.get('github')!;
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
      store: s, apps, clock,
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

    // Refuse the whoIs check on the next connect
    refuseWhoIs = true;
    await service.connect('github');
    await waitFor(async () => s.connectedAccounts.get('github')?.ended !== undefined, { what: 'connection marked ended' });

    const status2 = (await service.status())[0]!;
    expect(status2.state).toBe('expired');
    expect(logs.some((l) => l.includes('refused the new token'))).toBe(true);
    expect(told.some((s) => s.includes('refused the new token'))).toBe(true);
  });

  it('treats incorrect_client_credentials without client secret as token end, not app misconfiguration', async () => {
    const github = await forge();
    const clock = fixedClock(T0);
    const s = store(temp.url(), clock);
    const { service, logs, told } = hopper(github, s, clock);

    const first = await connect(service, s);

    // Simulate GitHub's incorrect_client_credentials on refresh (as happens when the authorization is revoked)
    // by deleting the refresh token (GitHub returns bad_refresh_token, which device flow without secret sees as incorrect_client_credentials)
    github.refreshTokens.delete(first.refreshToken!);

    // Try to renew the token (it's due in 1 hour, so advance the clock)
    clock.set(new Date(Date.parse(T0) + 7 * 3600_000).toISOString());

    // The connection should end, not retry forever
    await expect(service.token('github')).rejects.toThrow(/sign-in expired/);

    expect(told.some((s) => s.includes('refused the refresh token'))).toBe(true);
    expect(told.some((s) => s.includes('incorrect_client_credentials'))).toBe(true);
    // Should not treat it as an app misconfiguration
    expect(logs.every((l) => !l.includes('check HOPPER_GITHUB_CLIENT_ID'))).toBe(true);
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
