// Issue #2923, through the real composition root, the real HTTP server and a real joined box: a person's grant of a
// job's ask is a scope grant — the box's template and the job's repository —, so a later job that asks from the same
// scope gets the vault with no person. Revoke takes it back at once. A grant of an item whose job ended goes by itself.
//
// Feature: scope grants
//   Scenario: a second job that asks for an approved scope does not wait for a person
//     Given the vault secret KUBE_TOKEN in the approved scope of the template kube, a box joined as kube
//     And a job of the repository octo-org/hello that asked for KUBE_TOKEN, and a person granted its ask
//     When a second job of another item of octo-org/hello asks for KUBE_TOKEN from the same box
//     Then it gets the value, and no grant ask waits
//     And the Vault grants panel has one row for the scope, with both jobs under it
//   Scenario: a job of another repository still waits for a person
//   Scenario: a revoke takes effect at once
//     When a person revokes the scope grant
//     Then the running job's next ask is refused, and a grant ask waits for it
//   Scenario: the grant of an item whose job ended goes by itself
//     Given a person granted a job's item the vault, before it asked
//     When the job finishes
//     Then the Vault grants panel shows no row for it, and `vault.grant_revoked` says its job ended
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { boxes, helper } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'k3s-token-0123456789abcdef-never-on-disk';
const REPO = 'octo-org/hello';
const SCOPE = `template kube, repo ${REPO}`;

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

interface ScopeGrantView { key: string; template?: string; repo?: string; by: string; jobs: { job: string; ended: boolean }[]; live: number }
interface View { grantAsks?: { job: string; names: string[] }[]; grants?: { key: string }[]; scopeGrants?: ScopeGrantView[] }

async function boot(): Promise<{ a: TestApp; session: string; dir: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
  });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'KUBE_TOKEN', value: VALUE });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  await edit({ action: 'approve-template', name: 'kube' });
  const dir = await box.join(t, session, 'hopper-sandbox-kube', 'kube');
  return { a: t, session, dir };
}

async function running(a: TestApp, repo: string, ms: number): Promise<Job> {
  const job = await a.pull({ op: 'sleep', ms }, { repo });
  return a.waitForStatus(job.id, 'running', 10000);
}

const vault = async (a: TestApp): Promise<View> => (await a.api<View>('GET', '/api/vault')).body;

describe('scope grants', () => {
  it('a second job that asks for an approved scope gets the vault with no person; another repository still waits', async () => {
    const { a, session, dir } = await boot();
    const first = await running(a, REPO, 2500);
    expect(first.source?.repo).toBe(REPO);
    expect((await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, first.id))).stderr).toMatch(/has no vault grant/);
    const granted = await a.ui<View>(`/ui/api/jobs/${first.id}/grant-vault`, {}, { token: session });
    expect(granted.status).toBe(200);
    expect(granted.body.grants).toEqual([]);
    expect(granted.body.scopeGrants).toEqual([expect.objectContaining({ key: SCOPE, template: 'kube', repo: REPO, jobs: [expect.objectContaining({ job: first.id, ended: false })], live: 1 })]);
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, first.id))).toMatchObject({ code: 0, stdout: VALUE });
    await a.waitForStatus(first.id, 'finished', 10000);

    const second = await running(a, REPO, 4000);
    expect(second.source?.key).not.toBe(first.source?.key);
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, second.id))).toMatchObject({ code: 0, stdout: VALUE });
    const v = await vault(a);
    expect(v.grantAsks).toEqual([]);
    expect(v.scopeGrants).toEqual([expect.objectContaining({ key: SCOPE, jobs: [expect.objectContaining({ job: second.id, ended: false }), expect.objectContaining({ job: first.id, ended: true })], live: 1 })]);
    const grantedEvents = (await a.events()).filter((e) => e.type === 'vault.granted');
    expect(grantedEvents).toEqual([
      expect.objectContaining({ jobId: first.id, data: expect.objectContaining({ scope: SCOPE }) }),
      expect.objectContaining({ jobId: second.id, data: expect.objectContaining({ scope: SCOPE, by: expect.stringMatching(/^scope grant by /) }) }),
    ]);
    // Asked again, no second event for the job.
    await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, second.id));
    expect((await a.events()).filter((e) => e.type === 'vault.granted')).toHaveLength(2);

    await a.waitForStatus(second.id, 'finished', 10000);
    const other = await running(a, 'octo-org/other', 60000);
    expect((await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, other.id))).stderr).toMatch(/has no vault grant/);
    expect((await vault(a)).grantAsks?.map((g) => g.job)).toEqual([other.id]);
  });

  it('a revoke takes effect at once: the next ask of the scope waits for a person again', async () => {
    const { a, session, dir } = await boot();
    const job = await running(a, REPO, 60000);
    const token = box.tokenFileOf(a, job.id);
    await helper(dir, ['get', 'KUBE_TOKEN'], token);
    await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session });
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: VALUE });

    const revoked = await a.ui<View>('/ui/api/vault/revoke-scope-grant', { key: SCOPE }, { token: session });
    expect(revoked.status).toBe(200);
    expect(revoked.body.scopeGrants).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.grant_revoked')).toMatchObject({ jobId: job.id, data: { key: SCOPE, scope: SCOPE } });
    expect((await helper(dir, ['get', 'KUBE_TOKEN'], token)).stderr).toMatch(/has no vault grant/);
    expect((await vault(a)).grantAsks?.map((g) => g.job)).toEqual([job.id]);
    expect((await a.ui('/ui/api/vault/revoke-scope-grant', { key: SCOPE }, { token: session })).status).toBe(409);
  });

  it('the grant of an item whose job ended goes by itself: no stale row piles up', async () => {
    const { a, session } = await boot();
    const job = await running(a, REPO, 2500);
    // Granted before it asked: no scope is known, so the grant is the item's.
    expect((await a.ui<View>(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session })).body.grants).toEqual([expect.objectContaining({ key: job.source!.key })]);
    await a.waitForStatus(job.id, 'finished', 10000);
    expect((await vault(a)).grants).toEqual([]);
    expect((await a.events()).filter((e) => e.type === 'vault.grant_revoked')).toEqual([
      expect.objectContaining({ jobId: job.id, data: { job: job.id, key: job.source!.key, by: 'its job ended' } }),
    ]);
  });
});
