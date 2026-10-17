// Issue #655, part 2: a person quarantines a job. The daemon, store and HTTP edge are real; GitHub is a fake on loopback;
// the job's machine is a double at the MachineShell port whose credential files are real files.
//
// Feature: quarantine — gate 2's first step
//   Scenario: a quarantined running job reaches nothing through the hopper; its lift opens the doors again
//     Given a job running with its proxy token, which the GitHub proxy and the skill broker answer
//     When a person quarantines it
//     Then its stamp is `quarantined`, its level before kept, and `job.quarantined` names who acted
//     And the GitHub proxy and the skill broker refuse its token, and nothing reaches GitHub
//     When a person lifts the quarantine
//     Then its stamp has the level it had, `job.unquarantined` names who acted, and the doors answer it again
//   Scenario: quarantined twice, or lifted when it is not quarantined: 409; no person signed in: 401
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-quarantine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools']);
  const job = await app.pull({}, { executor: 'holder', repo: 'octo/tools' });
  const env = await waitFor(async () => h.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  const token = readFileSync(join(root, env.HOPPER_TOKEN_FILE!), 'utf8').trim();
  const github_ = () => fetch(`${app.url}/job/github`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'issue.view', repo: 'octo/tools', number: 1 }),
  });
  const skill = () => fetch(`${app.url}/job/skill`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args: [] }),
  });
  return { app, github, job, github_, skill, session: await app.login() };
}

const eventsOf = (a: TestApp, type: string) => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

describe('quarantine (issue #655)', () => {
  it('closes every door of the hopper to a running job, and its lift opens them again', async () => {
    const t = await start();
    const level = t.app.user(ADMIN_ID).store.jobs.get(t.job.id)!.stamp!.level;
    expect((await t.github_()).status).not.toBe(401);
    expect((await t.skill()).status).not.toBe(401);

    const q = await t.app.ui<Job>(`/ui/api/jobs/${t.job.id}/quarantine`, {}, { token: t.session });
    expect(q.status).toBe(200);
    expect(q.body.stamp).toMatchObject({ level: 'quarantined', was: level, by: 'person' });
    expect(eventsOf(t.app, 'job.quarantined')).toEqual([expect.objectContaining({ jobId: t.job.id, data: expect.objectContaining({ was: level, via: 'ui' }) })]);

    const before = t.github.requests.length;
    expect((await t.github_()).status).toBe(401);
    expect((await t.skill()).status).toBe(401);
    expect(t.github.requests.length).toBe(before);
    expect(t.app.user(ADMIN_ID).store.jobs.get(t.job.id)!.status).toBe('running');

    const lifted = await t.app.ui<Job>(`/ui/api/jobs/${t.job.id}/unquarantine`, {}, { token: t.session });
    expect(lifted.status).toBe(200);
    expect(lifted.body.stamp).toMatchObject({ level, by: 'person' });
    expect(lifted.body.stamp?.was).toBeUndefined();
    expect(eventsOf(t.app, 'job.unquarantined')).toEqual([expect.objectContaining({ jobId: t.job.id, data: expect.objectContaining({ level, via: 'ui' }) })]);
    expect((await t.github_()).status).not.toBe(401);
    expect((await t.skill()).status).not.toBe(401);
  });

  it('refuses a second quarantine, a lift of a job not quarantined, and an unknown job', async () => {
    const t = await start();
    expect((await t.app.ui(`/ui/api/jobs/${t.job.id}/unquarantine`, {}, { token: t.session })).status).toBe(409);
    expect((await t.app.ui(`/ui/api/jobs/${t.job.id}/quarantine`, {}, { token: t.session })).status).toBe(200);
    expect((await t.app.ui(`/ui/api/jobs/${t.job.id}/quarantine`, {}, { token: t.session })).status).toBe(409);
    expect((await t.app.ui('/ui/api/jobs/nope/quarantine', {}, { token: t.session })).status).toBe(404);
  });
});
