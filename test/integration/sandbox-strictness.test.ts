// Issue #655 part 8: sandbox strictness (brake 2), through the real daemon, store and HTTP edge.
//
// Feature: sandbox strictness
//   Scenario: an admin's setting, standard by default
//     Then GET /api/sandbox-strictness says standard, with no radius level or template set
//     And only an admin changes it; a bad value is 400; a change is recorded with who, once
//   Scenario: a tighter brake asks a person for a run the toggles approved, with no restart
//     Given sandbox YOLO on
//     When an admin locks every template
//     Then a job's sandbox request waits for a person
//     When an admin sets it back to standard
//     Then the next request is approved by the toggle
import { afterEach, describe, expect, it } from 'vitest';
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

const STANDARD = { default: 'standard', radius: {}, templates: {} };

describe('sandbox strictness (issue #655, brake 2)', () => {
  it('is an admin\'s setting, standard by default; a change is recorded', async () => {
    const a = await boot();
    expect((await a.api('GET', '/api/sandbox-strictness')).body).toEqual(STANDARD);
    expect((await a.ui('/ui/api/sandbox-strictness', { ...STANDARD, default: 'locked' })).status).toBe(403);
    const token = await a.login();
    expect((await a.ui('/ui/api/sandbox-strictness', { ...STANDARD, default: 'loose' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/sandbox-strictness', { ...STANDARD, radius: { huge: 'strict' } }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/sandbox-strictness', { ...STANDARD, templates: { 'not a name!': 'strict' } }, { token })).status).toBe(400);
    const to = { default: 'standard', radius: { high: 'strict' }, templates: { 'aws-prod': 'locked' } };
    expect(await a.ui('/ui/api/sandbox-strictness', to, { token })).toMatchObject({ status: 200, body: to });
    await a.ui('/ui/api/sandbox-strictness', to, { token });
    expect((await a.events('types=sandbox.strictness_changed')).map((e) => e.data)).toEqual([expect.objectContaining({ from: STANDARD, to })]);
  });

  it('a tighter brake asks a person for a run the toggles approved; a looser one lets the next run through, with no restart', async () => {
    const a = await boot();
    const token = await a.login();
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token })).status).toBe(200);
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    await a.waitForStatus(job.id, 'running', 10000);
    expect((await a.ui('/ui/api/sandbox-strictness', { ...STANDARD, default: 'locked' }, { token })).status).toBe(200);
    expect(a.user().sandboxRequests.ask(job.id, 'aws-prod').state).toBe('waiting');
    expect((await a.ui('/ui/api/sandbox-strictness', STANDARD, { token })).status).toBe(200);
    expect(a.user().sandboxRequests.ask(job.id, 'aws-staging')).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
  });
});
