// Issue #655, part 12: a tightened intake strictness (brake 1) re-checks started jobs at gate 2. The daemon, store and
// HTTP edge are real; the job runs on the scripted executor.
//
// Feature: a stricter brake asks a person at gate 2 for a running job its stamp no longer lets through
//   Scenario: an admin sets the job's source to strict while the job runs
//     Given a running job of the manual source, stamped approved, and sandbox YOLO on
//     When an admin sets the source's intake strictness to strict
//     Then the job keeps running, and its proxy token still opens the hopper's doors
//     And its sandbox request waits for a person, a need step is refused with the brake's name, and the stamp view says person
//     When the admin sets the source back to standard
//     Then its next sandbox request is approved by the toggle, with no restart
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath });
  apps.push(a);
  return a;
}

const strictness = (manual: string) => ({ default: 'standard', sources: { manual }, repos: {} });

describe('a tightened intake strictness at gate 2 (issue #655, part 12)', () => {
  it('asks a person for a running job below the brake; a looser brake lets the toggles approve again', async () => {
    const a = await boot();
    const session = await a.login();
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: session })).status).toBe(200);
    const job = await a.pull({ op: 'sleep', ms: 60_000 });
    await a.waitForStatus(job.id, 'running');
    expect(a.user(ADMIN_ID).store.jobs.get(job.id)!.stamp!.level).toBe('approved');

    expect((await a.ui('/ui/api/intake-strictness', strictness('strict'), { token: session })).status).toBe(200);
    expect(a.user(ADMIN_ID).store.jobs.get(job.id)!.status).toBe('running');
    const token = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
    const skill = await fetch(`${a.url}/job/skill`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args: [] }) });
    expect(skill.status).not.toBe(401);
    expect(a.user().sandboxRequests.ask(job.id, 'aws-prod').state).toBe('waiting');
    const step = await fetch(`${a.url}/job/step?needs=read/cluster/utility&key=step-0001&command=true`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(step.status).toBe(403);
    expect(await step.text()).toMatch(/its trust stamp approved is below trusted \(intake strictness strict for the source manual\): a need step runs only for a job at trusted or above/);
    expect((await a.api('GET', `/api/jobs/${job.id}/stamp`)).body).toMatchObject({ level: 'approved', gate2: 'person', doorsOpen: true, startHold: expect.stringMatching(/below trusted/) });

    expect((await a.ui('/ui/api/intake-strictness', strictness('standard'), { token: session })).status).toBe(200);
    expect(a.user().sandboxRequests.ask(job.id, 'aws-staging')).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    expect((await a.api('GET', `/api/jobs/${job.id}/stamp`)).body).toMatchObject({ gate2: 'auto', startHold: null });
  });
});
