// Issue #2088: pending approvals on the real daemon, store and HTTP edge. GitHub's answers are test/pending-approvals/.
//
// Feature: Pending approvals
//   Scenario: a fresh hopper with no GitHub connection
//     Then GET /api/pending-approvals answers no approval, no intake org, and not read yet
//     When the user's schedule reads
//     Then it says the connection is missing, and still lists no approval
//   Scenario: read-only
//     Then no route acts on a deployment
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type PendingApprovalsView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

describe('pending approvals', () => {
  it('answers what the schedule read, never GitHub at request time; with no connection it says so', { timeout: 40_000 }, async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const app = await startTestApp({ dbPath: db.dbPath });
    apps.push(app);
    const view = async () => (await app.api<PendingApprovalsView>('GET', '/api/pending-approvals')).body;

    expect(await view()).toEqual({ approvals: [], orgs: [], problems: [] });
    await app.user(ADMIN_ID).githubProxy.pendingApprovals.tick();
    const v = await view();
    expect(v.approvals).toEqual([]);
    expect(v.checkedAt).toEqual(expect.any(String));
    expect(v.problems).toEqual([{ where: 'github', error: expect.stringMatching(/not connected/) }]);

    const routes = (await app.api<{ paths: Record<string, unknown> }>('GET', '/docs/openapi.json')).body.paths;
    expect(Object.keys(routes).filter((p) => p.includes('pending-approvals'))).toEqual(['/api/pending-approvals']);
  });
});
