// Issue #1472, through the real composition root, the real HTTP server and a real joined box: the standing read grant, a
// user's setting, off by default. On, a job on a box of a template whose needs the read policy holds entirely as reads
// gets the vault grant with no person, recorded as `vault.granted` by the setting. Any template with a write, a read
// outside the policy or a vault secret still waits for a person's grant. Turned off, it grants no run that has not started.
//
// Feature: the standing read grant
//   Scenario: off by default, a read-only job is still refused and a person is asked
//   Scenario: on, a job on a read-only template gets the grant with no person
//     Given the read policy holds cluster/utility, a template utility-view of read cluster/utility only, a box joined as utility-view
//     And the standing read grant on
//     When a job on the box mints kube read cluster/utility
//     Then it is not refused for a vault grant, and vault.granted names the setting as its by
//     And no grant ask waits for a person
//   Scenario: turned off, a job that has not started gets nothing; the job it granted keeps it
//   Scenario: on, a job on a template with a read outside the read policy is still refused and a person is asked
//   Scenario: on, a job whose trust stamp is below approved (issue #655 part 7) is refused and a person is asked
//   Scenario: on, sandbox strictness locked for the template (issue #655 part 8): refused, and a person is asked
//   (a write, sync or apply, or a vault secret: test/domain/standing-read-grant.test.ts)
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { boxes, helper } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

const UTILITY = { kind: 'cluster', name: 'utility' };
const NO_GRANT = /has no vault grant/;

async function boot(o: { outside?: boolean } = {}): Promise<{ a: TestApp; session: string; dir: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 2, executors: ['scripted'] } },
  });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  expect((await edit({ action: 'set-read-policy', assets: ['cluster/utility'] })).status).toBe(200);
  const profiles = [{ operation: 'read', asset: UTILITY }, ...(o.outside ? [{ operation: 'read', asset: { kind: 'cluster', name: 'prod' } }] : [])];
  expect((await edit({ action: 'save-template', name: 'utility-view', image: 'localhost/box-kubectl:1', secrets: [], profiles })).status).toBe(200);
  await edit({ action: 'approve-template', name: 'utility-view' });
  const dir = await box.join(t, session, 'hopper-sandbox-utility', 'utility-view');
  return { a: t, session, dir };
}

async function running(a: TestApp): Promise<Job> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  return a.waitForStatus(job.id, 'running', 10000);
}

const standing = (a: TestApp, session: string, on: boolean) => a.ui('/ui/api/sandbox-approvals', { standingReadGrant: on }, { token: session });
const mint = (a: TestApp, dir: string, job: Job) => helper(dir, ['kube', 'read', 'cluster/utility'], box.tokenFileOf(a, job.id));
const grantEvents = async (a: TestApp) => (await a.events()).filter((e) => e.type === 'vault.granted');
const asks = async (a: TestApp) => ((await a.api<{ grantAsks?: { job: string }[] }>('GET', '/api/vault')).body.grantAsks ?? []).map((g) => g.job);

describe('the standing read grant (issue #1472)', () => {
  it('off by default: a job on a read-only template is refused, and a person is asked', async () => {
    const { a, dir } = await boot();
    const job = await running(a);
    expect((await mint(a, dir, job)).stderr).toMatch(NO_GRANT);
    expect(await asks(a)).toEqual([job.id]);
    expect(await grantEvents(a)).toEqual([]);
  });

  it('on: a job on a read-only template gets the grant with no person; turned off, a new job gets nothing, the granted one keeps it', async () => {
    const { a, session, dir } = await boot();
    expect((await standing(a, session, true)).status).toBe(200);
    expect((await a.events()).find((e) => e.type === 'vault.sandbox_approvals_set')).toMatchObject({ data: { standingReadGrant: true } });
    const first = await running(a);

    expect((await mint(a, dir, first)).stderr).not.toMatch(NO_GRANT);
    expect(await grantEvents(a)).toEqual([
      expect.objectContaining({ jobId: first.id, data: { job: first.id, key: first.source!.key, by: 'standing read grant' } }),
    ]);
    expect(await asks(a)).toEqual([]);
    // Asked again: one grant event for each job.
    await mint(a, dir, first);
    expect(await grantEvents(a)).toHaveLength(1);

    expect((await standing(a, session, false)).status).toBe(200);
    expect((await mint(a, dir, first)).stderr).not.toMatch(NO_GRANT);
    const second = await running(a);
    expect((await mint(a, dir, second)).stderr).toMatch(NO_GRANT);
    expect(await asks(a)).toEqual([second.id]);
    expect(await grantEvents(a)).toHaveLength(1);
  });

  it('on: a job below approved (issue #655 part 7) is refused, and a person is asked', async () => {
    const { a, session, dir } = await boot();
    await standing(a, session, true);
    const job = await running(a);
    expect(a.user().store.jobs.deny(job.id)!.stamp!.level).toBe('screened');
    expect((await mint(a, dir, job)).stderr).toMatch(NO_GRANT);
    expect(await asks(a)).toEqual([job.id]);
    expect(await grantEvents(a)).toEqual([]);
  });

  it('on: sandbox strictness locked for the template (issue #655 part 8): the job is refused, and a person is asked', async () => {
    const { a, session, dir } = await boot();
    await standing(a, session, true);
    expect((await a.ui('/ui/api/sandbox-strictness', { default: 'standard', radius: {}, templates: { 'utility-view': 'locked' } }, { token: session })).status).toBe(200);
    const job = await running(a);
    expect((await mint(a, dir, job)).stderr).toMatch(NO_GRANT);
    expect(await asks(a)).toEqual([job.id]);
    expect(await grantEvents(a)).toEqual([]);
  });

  it('on: a job on a template with a read the policy does not hold is refused, and a person is asked', async () => {
    const { a, session, dir } = await boot({ outside: true });
    await standing(a, session, true);
    const job = await running(a);
    expect((await mint(a, dir, job)).stderr).toMatch(NO_GRANT);
    expect(await asks(a)).toEqual([job.id]);
    expect(await grantEvents(a)).toEqual([]);
  });
});
