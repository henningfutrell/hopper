// Issue #2761: the hopper's app installed on a new owner (or a repository added to an installation) after GitHub was
// connected. The installations' schedule reads it, the new repositories become job repositories of the connected account
// — not one another account holds, and none of a personal access token's —, the account's job source syncs at once, and
// Sources shows what was added. No reconnect.
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectedAccounts, type ConnectedAccountsOptions } from '../../src/connected-accounts/service.ts';
import type { DeviceFlow, Grant } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { FRESH_MS } from '../../src/connected-accounts/installations.ts';
import type { AppInstallation } from '../../src/domain/types.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';
import { waitFor } from '../support/wait.ts';

const T0 = Date.parse('2026-10-15T10:00:00Z');
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const USER: AppInstallation = { account: 'octo-user', repositorySelection: 'selected', repositories: ['octo-user/tools', 'octo-user/notes'] };
const ORG: AppInstallation = { account: 'acme', repositorySelection: 'all', repositories: ['acme/api', 'acme/web'] };

const approved = (grantedBy: Grant['grantedBy'] = 'device'): DeviceFlow => ({
  start: async () => ({
    userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: new Date(T0 + 900_000),
    grant: async (): Promise<Grant> => ({ accessToken: 'ghu_device', grantedBy }),
  }),
});

function setup(o: Partial<ConnectedAccountsOptions> = {}) {
  let now = T0;
  let found: AppInstallation[] = [USER];
  let chosen: string[] = ['octo-user/tools'];
  const changes: string[] = [], logs: string[] = [];
  const { store } = memoryAccountStore(undefined, { settings: { getJobRepositories: () => chosen, setJobRepositories: (_k: string, r: string[]) => { chosen = [...r]; } } });
  const service = createConnectedAccounts({
    store, secrets: systemOf(store), apps: hopperApps({ github: { clientId: 'Iv1.hopper' } }),
    whoIs: async () => ({ subject: '7', account: 'octo-user' }),
    installations: async () => found, tokenRepositories: async () => found,
    clock: { now: () => new Date(now) },
    logger: { info: (l) => logs.push(l), warn: (l) => logs.push(l) },
    flows: { github: approved() },
    refresh: async () => { throw new Error('no renewal in this test'); },
    onChange: (key) => { changes.push(key); },
    ...o,
  });
  cleanups.push(() => service.stop());
  return {
    service, changes, logs,
    chosen: () => chosen,
    install: (i: AppInstallation[]) => { found = i; },
    later: () => { now += FRESH_MS; },
  };
}

async function connected(s: ReturnType<typeof setup>) {
  await s.service.connect('github');
  await waitFor(async () => { const [g] = await s.service.status(); return g?.state === 'connected' && g.installations !== undefined && g.installationsReading === undefined; }, { what: 'github connected' });
  s.changes.length = 0;
}

describe('the app installed on a new owner after GitHub was connected (issue #2761)', () => {
  it('the schedule finds the new owner: its repositories become job repositories, the source syncs, and Sources shows it', async () => {
    const s = setup();
    await connected(s);
    expect(s.chosen()).toEqual(['octo-user/tools']); // a connect chooses nothing by itself
    s.install([USER, ORG]);
    s.later();
    s.service.start();
    await waitFor(() => s.chosen().length === 3, { what: 'the new owner\'s repositories chosen' });
    expect(s.chosen()).toEqual(['octo-user/tools', 'acme/api', 'acme/web']);
    expect(s.changes).toEqual(['github']);
    const [g] = await s.service.status();
    expect(g).toMatchObject({ state: 'connected', jobRepositories: ['octo-user/tools', 'acme/api', 'acme/web'], jobRepositoriesAdded: { repositories: ['acme/api', 'acme/web'] } });
    expect(s.logs.join('\n')).toContain('2 new repositories the app reaches added for jobs: acme/api, acme/web');
  });

  it('a repository the person left unchosen stays unchosen; a Refresh takes a new one at once', async () => {
    const s = setup();
    await connected(s);
    s.install([{ ...USER, repositories: [...USER.repositories, 'octo-user/new'] }]);
    s.service.refresh('github');
    await waitFor(() => s.chosen().includes('octo-user/new'), { what: 'the new repository chosen' });
    expect(s.chosen()).toEqual(['octo-user/tools', 'octo-user/new']); // octo-user/notes was read before: the person's to choose
    expect(s.changes).toEqual(['github']);
  });

  it('a repository another account holds is not taken', async () => {
    const s = setup({ takenElsewhere: (repo) => repo === 'acme/web' });
    await connected(s);
    s.install([USER, ORG]);
    s.service.refresh('github');
    await waitFor(() => s.chosen().length > 1, { what: 'the new owner\'s repositories chosen' });
    expect(s.chosen()).toEqual(['octo-user/tools', 'acme/api']);
  });

  it('a personal access token\'s new repositories are not taken: the token reaches every repository its user does', async () => {
    const s = setup({ flows: { github: approved() } });
    await s.service.connectToken('github', 'github_pat_1', {});
    s.changes.length = 0;
    s.install([USER, ORG]);
    s.service.refresh('github');
    await waitFor(async () => { const [g] = await s.service.status(); return g?.state === 'connected' && g.installations?.length === 2 && g.installationsReading === undefined; }, { what: 'read again' });
    expect(s.chosen()).toEqual(['octo-user/tools']);
    expect(s.changes).toEqual([]);
  });
});
