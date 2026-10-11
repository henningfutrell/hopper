// Issue #652, requirement 5, through the real composition root, the real HTTP server and a real joined box: a job gets
// the vault's helper only when a person granted it the vault. A job on a box asks; with no grant it is refused, and the
// hopper asks a person (a vault grant ask, on the Vault page). Grant is a person's act through the UI session, and Access
// decides it (OpenFGA `vault_grant#can_grant`); a job asks, never grants. The grant is kept for the job's item, so Run
// again and Rework keep it. The template's approved scope still bounds what a granted job gets. Revoke takes it back.
//
// Feature: the vault only by a per-job grant
//   Scenario: a job with no grant is refused, and a person is asked
//     Given the vault secret KUBE_TOKEN in the approved scope of the template kube, a box joined as kube
//     And a job running on the box, with no vault grant
//     When the job runs `$HOPPER_SECRET get KUBE_TOKEN`
//     Then it is refused: the job has no vault grant
//     And the Vault page lists a grant ask for the job, with the secret it asked for
//   Scenario: granted, the job gets the value; the scope still bounds it
//     When a person grants the job the vault
//     Then the job gets KUBE_TOKEN, and the ask goes
//     And a secret outside the template's scope is still refused
//   Scenario: Run again keeps the grant
//     Given a granted job that ended
//     When a person runs it again
//     Then the new job gets KUBE_TOKEN with no new grant
//   Scenario: revoked, the job is refused again
//   Scenario: a mint asks the same grant
//   Scenario: Access decides; OpenFGA that cannot be asked grants nothing (503)
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { boxes, helper } from '../support/vault-box.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'k3s-token-0123456789abcdef-never-on-disk';

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

interface GrantAsk { job: string; key: string; machine: string; template: string; names: string[]; askedAt: string }
interface GrantView { key: string; job: string; by: string; at: string }

async function boot(server: FakeAuthorizationServer = createFakeAuthorizationServer()): Promise<{ a: TestApp; session: string; dir: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: server },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
  });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'KUBE_TOKEN', value: VALUE });
  await edit({ action: 'set', name: 'PROD_KEY', value: 'prod-never-given' });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  await edit({ action: 'approve-template', name: 'kube' });
  const dir = await box.join(t, session, 'hopper-sandbox-kube', 'kube');
  return { a: t, session, dir };
}

async function running(a: TestApp, over: Record<string, unknown> = {}, ms = 60000): Promise<Job> {
  const job = await a.pull({ op: 'sleep', ms }, over);
  return a.waitForStatus(job.id, 'running', 10000);
}

const vault = async (a: TestApp) => (await a.api<{ grantAsks?: GrantAsk[]; grants?: GrantView[] }>('GET', '/api/vault')).body;

describe('the vault only by a per-job grant', () => {
  it('a job with no grant is refused and a person is asked; granted, it gets the value, within the template\'s scope', async () => {
    const { a, session, dir } = await boot();
    const job = await running(a);
    const token = box.tokenFileOf(a, job.id);

    const refused = await helper(dir, ['get', 'KUBE_TOKEN'], token);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/has no vault grant/);
    expect(refused.stdout).toBe('');
    expect((await vault(a)).grantAsks).toEqual([
      { job: job.id, key: job.source!.key, machine: 'hopper-sandbox-kube', template: 'kube', names: ['KUBE_TOKEN'], askedAt: expect.any(String) },
    ]);
    expect((await a.events()).filter((e) => e.type === 'vault.grant_asked')).toEqual([
      expect.objectContaining({ jobId: job.id, data: { job: job.id, key: job.source!.key, machine: 'hopper-sandbox-kube', template: 'kube', name: 'KUBE_TOKEN' } }),
    ]);
    // Asked again, the same ask: one event for each job.
    await helper(dir, ['get', 'KUBE_TOKEN'], token);
    expect((await a.events()).filter((e) => e.type === 'vault.grant_asked')).toHaveLength(1);

    const granted = await a.ui<{ grants: GrantView[]; grantAsks: GrantAsk[] }>(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session });
    expect(granted.status).toBe(200);
    expect(granted.body.grantAsks).toEqual([]);
    expect(granted.body.grants).toEqual([{ key: job.source!.key, job: job.id, by: expect.any(String), at: expect.any(String) }]);
    expect((await a.events()).find((e) => e.type === 'vault.granted')).toMatchObject({ jobId: job.id, data: { job: job.id, key: job.source!.key } });

    expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: VALUE });
    const outside = await helper(dir, ['get', 'PROD_KEY'], token);
    expect(outside.stderr).toMatch(/kube is not approved for PROD_KEY/);
    expect(JSON.stringify(await a.events())).not.toContain(VALUE);
  });

  it('Run again keeps the grant: the next job of the same item gets the value with no new grant', async () => {
    const { a, session, dir } = await boot();
    const first = await running(a, {}, 2500);
    expect((await a.ui(`/ui/api/jobs/${first.id}/grant-vault`, {}, { token: session })).status).toBe(200);
    await a.waitForStatus(first.id, 'finished', 10000);
    await waitFor(async () => (await a.job(first.id)).sourceState?.sync?.finalReported === true, { what: 'the end reported' });
    const again = await a.ui<Job>(`/ui/api/jobs/${first.id}/rerun`, {}, { token: session });
    expect(again.status).toBe(200);
    expect(again.body.id).not.toBe(first.id);
    await a.waitForStatus(again.body.id, 'running', 10000);
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, again.body.id))).toMatchObject({ code: 0, stdout: VALUE });
    expect((await a.events()).filter((e) => e.type === 'vault.grant_asked')).toEqual([]);
  });

  it('revoked, the job is refused again; a mint asks the same grant', async () => {
    const { a, session, dir } = await boot();
    const job = await running(a);
    const token = box.tokenFileOf(a, job.id);
    await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session });
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: VALUE });

    const revoked = await a.ui<{ grants: GrantView[] }>(`/ui/api/jobs/${job.id}/revoke-vault`, {}, { token: session });
    expect(revoked.status).toBe(200);
    expect(revoked.body.grants).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.grant_revoked')).toMatchObject({ jobId: job.id, data: { job: job.id, key: job.source!.key } });
    expect((await helper(dir, ['get', 'KUBE_TOKEN'], token)).stderr).toMatch(/has no vault grant/);
    const mint = await helper(dir, ['kube', 'read', 'namespace/lab/web'], token);
    expect(mint.code).not.toBe(0);
    expect(mint.stderr).toMatch(/has no vault grant/);
    expect((await vault(a)).grantAsks?.map((g) => g.names)).toEqual([['KUBE_TOKEN', 'kube read namespace/lab/web']]);
    // Revoked twice: nothing to revoke.
    expect((await a.ui(`/ui/api/jobs/${job.id}/revoke-vault`, {}, { token: session })).status).toBe(409);
  });

  it('Access decides: OpenFGA that cannot be asked grants nothing (503), and the job stays refused', async () => {
    const server = createFakeAuthorizationServer();
    const { a, session, dir } = await boot(server);
    const job = await running(a);
    const token = box.tokenFileOf(a, job.id);
    await helper(dir, ['get', 'KUBE_TOKEN'], token);
    server.reachable = false;
    const r = await a.ui<{ error: string }>(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/OpenFGA cannot be asked/);
    expect((await a.events()).filter((e) => e.type === 'vault.granted')).toEqual([]);
    expect((await helper(dir, ['get', 'KUBE_TOKEN'], token)).stderr).toMatch(/has no vault grant/);
    expect((await a.ui(`/ui/api/jobs/no-such-job/grant-vault`, {}, { token: session })).status).toBe(404);
    expect(server.checks.some((c) => c.tuple.relation === 'can_grant' && c.tuple.object.startsWith('vault_grant:'))).toBe(false);
    server.reachable = true;
    await waitFor(async () => ((await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session })).status === 200 ? true : undefined), { what: 'the grant once OpenFGA answers' });
    expect(server.checks.some((c) => c.tuple.relation === 'can_grant' && c.tuple.object.startsWith('vault_grant:'))).toBe(true);
  });
});
