// A connected account whose sign-in ended reads as expired, never as connected (issue #358): its login is
// no longer offered (`account()` is undefined), so the gh source that pauses for a connected account runs
// again, and the account's source says to connect again. A record kept before refresh tokens were stored
// (an expired token, no refresh token) reads as expired too, and is told once.
import { describe, expect, it } from 'vitest';
import type { ConnectedAccount } from '../../src/domain/ports.ts';
import { createConnectedAccounts } from '../../src/connected-accounts/service.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { createGhSource } from '../../src/sources/compose.ts';

const NOW = Date.parse('2026-10-07T21:00:00Z');

function service(record: ConnectedAccount | undefined, refresh = async (): Promise<never> => { throw Object.assign(new Error('bad'), { error: 'bad_refresh_token' }); }) {
  let kept = record;
  const told: string[] = [];
  const s = createConnectedAccounts({
    store: {
      connectedAccounts: { get: () => kept, put: (a: ConnectedAccount) => { kept = a; }, delete: () => { const had = kept !== undefined; kept = undefined; return had; } },
      settings: { getJobRepositories: () => ['octo-user/tools'], setJobRepositories: () => undefined },
    } as never,
    apps: hopperApps({ github: {} }),
    whoIs: async () => ({ subject: '1', account: 'octo-user' }),
    installations: async () => [],
    clock: { now: () => new Date(NOW) },
    logger: { info: () => undefined, warn: () => undefined },
    refresh: refresh as never,
    onExpired: (_p, account, reason) => { told.push(`${account}: ${reason}`); },
  });
  return { s, told, kept: () => kept };
}

const legacy: ConnectedAccount = {
  provider: 'github', account: 'octo-user', subject: '1', accessToken: 'gho_old', connectedAt: '2026-10-07T12:14:00Z', expiresAt: '2026-10-07T20:14:00Z',
};

describe('an expired connected account', () => {
  it('reads as expired, offers no login, and lets the gh source run', async () => {
    const { s, told } = service(legacy);
    const [status] = await s.status();
    expect(status).toMatchObject({ provider: 'github', state: 'expired', account: 'octo-user', error: expect.stringMatching(/no refresh token/) });
    expect(s.account('github')).toBeUndefined();
    expect(s.ended('github')).toBe('GitHub\'s sign-in expired: Sources → Connect GitHub again');
    await expect(s.token('github')).rejects.toThrow('GitHub\'s sign-in expired: Sources → Connect GitHub again');
    expect(told).toHaveLength(1);
    const gh = createGhSource({ name: 'github', clock: { now: () => new Date(NOW) }, knownKeys: () => new Set(), rerunnable: () => new Set(), env: () => undefined, accounts: s },
      { enabled: 'auto', bin: 'gh', appKeyEnv: null } as never);
    expect(gh.paused?.()).toBeUndefined();
  });

  it('a refresh token GitHub refuses ends the sign-in, told once', async () => {
    const { s, told } = service({ ...legacy, refreshToken: 'ghr_1', refreshTokenExpiresAt: '2027-04-07T12:14:00Z' });
    await expect(s.token('github')).rejects.toThrow(/sign-in expired/);
    await expect(s.token('github')).rejects.toThrow(/sign-in expired/);
    expect(told).toEqual([expect.stringMatching(/^octo-user: GitHub refused the refresh token/)]);
    expect((await s.status())[0]).toMatchObject({ state: 'expired' });
  });

  it('GitHub not answering a renewal is no end: the token is asked for again', async () => {
    const { s, told } = service({ ...legacy, refreshToken: 'ghr_1', refreshTokenExpiresAt: '2027-04-07T12:14:00Z' }, async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(s.token('github')).rejects.toThrow(/could not renew .*ECONNREFUSED/);
    expect(told).toEqual([]);
    expect(s.account('github')).toBe('octo-user');
  });
});
