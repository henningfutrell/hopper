// Issue #655, part 15: a profile's minimum trust, through the real daemon, store and HTTP edge, with OpenFGA as a double
// at the AuthorizationServer seam. The runtime tells Access each live job's trust level as its stamp verifies, and the
// hopper writes it to OpenFGA. The instance admin sets a minimum trust on an operation profile in Users & access → Access
// (POST /ui/api/access, `min-trust`): no job below it gets that operation, whatever its template's approvals say.
//
// Feature: a minimum trust in Users & access → Access
//   Scenario: a running job's trust is written to OpenFGA and shown on its matrix row
//   Scenario: the admin sets and clears a minimum trust; a level that is no minimum is refused
//   Scenario: a trial is told the level it names
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessDecisionRecord, AccessView } from '../../src/domain/types.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const X = { kind: 'cluster', name: 'x' } as const;

async function boot(): Promise<{ a: TestApp; server: FakeAuthorizationServer; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const server = createFakeAuthorizationServer();
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) }, seams: { authorizationServer: server } });
  apps.push(a);
  return { a, server, token: await a.login() };
}

const view = async (a: TestApp, token: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body;
const edit = <T = AccessView>(a: TestApp, token: string, body: unknown) => a.ui<T>('/ui/api/access', body, { token });
const held = (server: FakeAuthorizationServer): string[] => [...server.storeTuples([...server.stores.keys()][0]!).keys()];

describe('a minimum trust in Users & access → Access (issue #655, part 15)', () => {
  it('writes a running job\'s trust to OpenFGA, and shows it on the job\'s row', async () => {
    const { a, server, token } = await boot();
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    const running = await a.waitForStatus(job.id, 'running', 10000);
    const user = a.user().user.id;
    const level = a.user().store.jobs.trustLevel(running);
    expect(level).toBeDefined();

    await a.app.access.sync();
    expect(held(server)).toContain(`job:${user}/${job.id} holder trust:${level}`);
    expect((await view(a, token)).requesters.find((r) => r.requester.kind === 'job')).toMatchObject({ trust: level });
  });

  it('lets the admin set and clear a minimum trust, and refuses a level that is no minimum', async () => {
    const { a, token } = await boot();
    const set = await edit(a, token, { action: 'min-trust', operation: 'write', asset: X, level: 'trusted' });
    expect(set.status).toBe(200);
    expect(set.body.minTrust).toEqual([{ profile: { operation: 'write', asset: X }, level: 'trusted', setBy: expect.any(String), setAt: expect.any(String) }]);
    expect((await edit(a, token, { action: 'min-trust', operation: 'write', asset: X, level: 'quarantined' })).status).toBe(400);
    const cleared = await edit(a, token, { action: 'min-trust', operation: 'write', asset: X, level: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.minTrust).toEqual([]);
  });

  it('tells a trial the level it names', async () => {
    const { a, token } = await boot();
    expect((await edit(a, token, { action: 'approve', template: 'kubectl-diag', operation: 'read', asset: X })).status).toBe(200);
    expect((await edit(a, token, { action: 'min-trust', operation: 'read', asset: X, level: 'trusted' })).status).toBe(200);
    const check = (level?: string) => edit<AccessDecisionRecord>(a, token, { action: 'check', template: 'kubectl-diag', operation: 'read', asset: X, ...(level ? { level } : {}) });
    expect((await check()).body).toMatchObject({ allowed: true, trial: { by: expect.any(String) } });
    expect((await check('approved')).body).toMatchObject({ allowed: false, trial: { level: 'approved' } });
    expect((await check('trusted')).body).toMatchObject({ allowed: true, trial: { level: 'trusted' } });
  });
});
