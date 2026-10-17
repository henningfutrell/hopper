// Issue #655, part 6: a quarantine closes what the job holds. The daemon, store and HTTP edge are real; the job's item gets
// its vault grant through the user's vault, as a person's grant does.
//
// Feature: a quarantine takes back what the job holds
//   Scenario: a person's quarantine revokes the item's vault grant, and the job's steps may no longer run
//     Given a running job whose item has a vault grant
//     When a person quarantines it
//     Then the grant is gone, and `vault.grant_revoked` names who quarantined it
//     And the job's steps are not at work, so a running step stops and a waiting one does not start
//     When a person lifts the quarantine
//     Then the steps may run again, and the grant stays revoked: a person grants it again
//   Scenario: a second deny at gate 2 quarantines the job, and revokes its grant the same way
//   Scenario: a job with no grant: the quarantine revokes nothing
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { grantKeyOf } from '../../src/domain/vault-grants.ts';
import { stepsMayRun } from '../../src/users/quarantine.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function start() {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  return { a, job, session: await a.login() };
}

const store = (a: TestApp) => a.user(ADMIN_ID).store;
const eventsOf = (a: TestApp, type: string) => store(a).events.recent(1000).filter((e) => e.type === type);
const grantOf = (a: TestApp, id: string) => store(a).vaultGrants.get(grantKeyOf(store(a).jobs.get(id)!));

describe('a quarantine takes back what the job holds (issue #655, part 6)', () => {
  it('revokes the item\'s vault grant, and the job\'s steps stop until the lift', async () => {
    const t = await start();
    expect(t.a.user().vault.grant!(t.job.id, 'ada')).toEqual({ ok: true });
    const mayRun = stepsMayRun(store(t.a).jobs);
    expect(mayRun(t.job.id)).toBe(true);

    expect((await t.a.ui(`/ui/api/jobs/${t.job.id}/quarantine`, {}, { token: t.session })).status).toBe(200);
    expect(mayRun(t.job.id)).toBe(false);
    await waitFor(async () => (grantOf(t.a, t.job.id) ? undefined : true), { what: 'the grant revoked' });
    const revoked = eventsOf(t.a, 'vault.grant_revoked');
    expect(revoked).toEqual([expect.objectContaining({ jobId: t.job.id, data: expect.objectContaining({ job: t.job.id, by: expect.stringContaining('quarantine') }) })]);

    expect((await t.a.ui(`/ui/api/jobs/${t.job.id}/unquarantine`, {}, { token: t.session })).status).toBe(200);
    expect(mayRun(t.job.id)).toBe(true);
    expect(grantOf(t.a, t.job.id)).toBeUndefined();
  });

  it('a second deny at gate 2 quarantines the job and revokes its grant', async () => {
    const t = await start();
    t.a.user().vault.grant!(t.job.id, 'ada');
    for (const template of ['aws-prod', 'aws-staging']) {
      const r = t.a.user().sandboxRequests.ask(t.job.id, template);
      expect((await t.a.ui('/ui/api/sandbox-requests', { action: 'decline', id: r.id, reason: 'no' }, { token: t.session })).status).toBe(200);
    }
    expect(store(t.a).jobs.get(t.job.id)!.stamp!.level).toBe('quarantined');
    await waitFor(async () => (grantOf(t.a, t.job.id) ? undefined : true), { what: 'the grant revoked' });
    expect(stepsMayRun(store(t.a).jobs)(t.job.id)).toBe(false);
  });

  it('a job with no grant: the quarantine revokes nothing', async () => {
    const t = await start();
    expect((await t.a.ui(`/ui/api/jobs/${t.job.id}/quarantine`, {}, { token: t.session })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(eventsOf(t.a, 'vault.grant_revoked')).toEqual([]);
    expect(stepsMayRun(store(t.a).jobs)('no-such-job')).toBe(false);
  });
});
