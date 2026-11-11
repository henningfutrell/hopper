// Issue #2639 part 3, through the real composition root and the real HTTP server, with OpenFGA and the container
// runtime as doubles at their ports: a critical job needed three clicks for one template — its run card, then a vault
// grant for the template's secret. Now one card per job and template carries all three, and one approve-run approves
// the template, the job's sandbox run and the job's vault grant together.
//
// Feature: one card per job per template
//   Scenario: a job asks for the sandbox runs of a waiting template that gives a vault secret
//     Then its run card says the approval also grants the job the vault
//     When a person approves the card once
//     Then the template and the run are approved, and the job's item has its vault grant, by that person
//   Scenario: a job whose item has a vault grant already: its card grants nothing more
//   Scenario: a second job that asks for the same template waits for no person (issue #2923)
//     Given a person approved the first job's card once
//     When a second job of another item asks for the sandbox runs of web
//     Then it gets no run card and no grant ask: the approval and the card's scope grant cover it
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

/** A hopper with the waiting template web, which gives the vault secret web-token. */
async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(2) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: createFakeContainerRuntime() } });
  apps.push(a);
  const token = await a.login();
  expect((await a.ui('/ui/api/vault', { action: 'set', name: 'web-token', value: 'example-value-0123456789' }, { token })).status).toBe(200);
  expect((await a.ui('/ui/api/vault', { action: 'save-template', name: 'web', image: 'localhost/box-web:1', secrets: ['web-token'] }, { token })).status).toBe(200);
  return { a, token };
}

/** A running job that asked for the sandbox runs of web: its id, once its ask waits for a person. */
async function asking(a: TestApp): Promise<string> {
  const { job, code } = await asks(a);
  expect(code).toBe(3);
  return job;
}

/** A running job that asked for the sandbox runs of web: its id, and the skill's exit code (3: it waits for a person). */
async function asks(a: TestApp): Promise<{ job: string; code: number }> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  const dir = mkdtempSync(join(tmpdir(), 'job-credentials-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  const code = await new Promise<number>((resolve) => {
    execFile('sh', [join(dir, 'skill'), 'sandbox', '--template', 'web', '--why', 'deploy the web service'], { env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(dir, 'token') } },
      (err) => resolve(err ? Number((err as { code?: number }).code ?? 1) : 0));
  });
  return { job: job.id, code };
}

const view = async (a: TestApp, token: string): Promise<VaultView> => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;

describe('one card per job per template (issue #2639 part 3)', () => {
  it('one approve-run approves the template and the run, and grants the job the vault', async () => {
    const { a, token } = await boot();
    const job = await asking(a);
    const [card] = (await view(a, token)).runs ?? [];
    expect(card).toMatchObject({ jobId: job, template: 'web', waits: { template: true }, vaultGrant: true });
    const r = await a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve-run', job, template: 'web' }, { token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.runs ?? []).toEqual([]);
    expect(r.body.templates.find((t) => t.name === 'web')?.approval).toBeDefined();
    // The card's grant is a scope grant (issue #2923): the template web, for the job's repository.
    expect(r.body.grants).toEqual([]);
    expect(r.body.scopeGrants?.map((g) => ({ template: g.template, jobs: g.jobs.map((j) => j.job) }))).toEqual([{ template: 'web', jobs: [job] }]);
    const types = (await a.events()).filter((e) => e.jobId === job || e.type === 'vault.approved').map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['vault.granted', 'vault.approved']));
  });

  it('a job whose item has a vault grant already: its card grants nothing more', async () => {
    const { a, token } = await boot();
    const job = await asking(a);
    expect((await a.ui(`/ui/api/jobs/${job}/grant-vault`, {}, { token })).status).toBe(200);
    const [card] = (await view(a, token)).runs ?? [];
    expect(card).toMatchObject({ jobId: job, template: 'web' });
    expect(card).not.toHaveProperty('vaultGrant');
  });

  it('a second job that asks for the same template waits for no person (issue #2923)', async () => {
    const { a, token } = await boot();
    const first = await asking(a);
    expect((await a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve-run', job: first, template: 'web' }, { token })).status).toBe(200);
    const second = await asks(a);
    const v = await view(a, token);
    expect(second.code).toBe(0);
    expect(v.runs ?? []).toEqual([]);
    expect(v.grantAsks ?? []).toEqual([]);
    expect(v.sandboxRequests?.find((x) => x.jobId === second.job)).toMatchObject({ state: 'approved', approvedBy: expect.stringMatching(/^scope grant by /) });
    expect(v.scopeGrants?.map((g) => ({ template: g.template, runs: g.runs, jobs: g.jobs.map((j) => j.job) }))).toEqual([{ template: 'web', runs: true, jobs: [second.job, first] }]);
  });
});
