// Issue #655, part 5: gate 2's denies. The daemon, store and HTTP edge are real; the job asks for its sandbox runs through
// the user's sandbox requests, as the skill broker does.
//
// Feature: a person's deny lowers a job's trust
//   Scenario: a running job's first declined sandbox request lowers its trust one level; the second quarantines it
//     Given a running job of the rules' level
//     When a person declines its sandbox request
//     Then its stamp is one level lower, signed by a person, and `job.trust_lowered` names who acted
//     And the job keeps running, and its proxy token still opens the hopper's doors
//     When a person declines a second sandbox request of the job
//     Then its stamp is `quarantined`, its level before kept, and `job.quarantined` names who acted and the deny
//     And its proxy token opens no door of the hopper
//   Scenario: an approved request, or a decline of a request that no longer waits, changes no trust
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { DENY_REASON } from '../../src/domain/trust-stamp.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

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
  const token = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
  const skill = () => fetch(`${a.url}/job/skill`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args: [] }),
  });
  return { a, job, skill, session: await a.login() };
}

const stored = (a: TestApp, id: string): Job => a.user(ADMIN_ID).store.jobs.get(id)!;
const eventsOf = (a: TestApp, type: string) => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const decline = (t: Awaited<ReturnType<typeof start>>, id: string) =>
  t.a.ui('/ui/api/sandbox-requests', { action: 'decline', id, reason: 'not this account' }, { token: t.session });

describe('a person\'s deny at gate 2 (issue #655, part 5)', () => {
  it('lowers a running job\'s trust one level, and the second deny quarantines it', async () => {
    const t = await start();
    const level = stored(t.a, t.job.id).stamp!.level;
    expect(level).toBe('approved');
    const first = t.a.user().sandboxRequests.ask(t.job.id, 'aws-prod');
    expect((await decline(t, first.id)).status).toBe(200);
    expect(stored(t.a, t.job.id).stamp).toMatchObject({ level: 'screened', by: 'person', reasons: expect.arrayContaining([DENY_REASON]) });
    expect(eventsOf(t.a, 'job.trust_lowered')).toEqual([expect.objectContaining({
      jobId: t.job.id, data: expect.objectContaining({ from: 'approved', to: 'screened', reason: DENY_REASON, by: 'person', via: 'ui' }),
    })]);
    expect(stored(t.a, t.job.id).status).toBe('running');
    expect((await t.skill()).status).not.toBe(401);

    const second = t.a.user().sandboxRequests.ask(t.job.id, 'aws-staging');
    expect((await decline(t, second.id)).status).toBe(200);
    expect(stored(t.a, t.job.id).stamp).toMatchObject({ level: 'quarantined', was: 'screened', by: 'person' });
    expect(eventsOf(t.a, 'job.quarantined')).toEqual([expect.objectContaining({
      jobId: t.job.id, data: expect.objectContaining({ was: 'screened', reason: DENY_REASON, via: 'ui' }),
    })]);
    expect((await t.skill()).status).toBe(401);
  });

  it('an approved request, or a decline of a request that no longer waits, changes no trust', async () => {
    const t = await start();
    const r = t.a.user().sandboxRequests.ask(t.job.id, 'aws-prod');
    expect((await t.a.ui('/ui/api/sandbox-requests', { action: 'approve', id: r.id }, { token: t.session })).status).toBe(200);
    expect((await decline(t, r.id)).status).toBe(409);
    expect((await decline(t, 'nope')).status).toBe(404);
    expect(stored(t.a, t.job.id).stamp!.level).toBe('approved');
    expect(eventsOf(t.a, 'job.trust_lowered')).toEqual([]);
  });
});
