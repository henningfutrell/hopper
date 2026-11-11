// Issue #2229: the owner's API key with no limits (a grant of the scope `*`) lists Access requests and grants or denies a
// job's vault grant ask, recorded as that key. A route that does not exist answers 404, not a scope refusal; a real route
// a key is not scoped for answers 403 that names the scope it needs. Real daemon, real HTTP server and a real joined box;
// OpenFGA is a double at its port.
//
// Feature: the owner's no-limits key on Access requests
//   Scenario: an unknown route answers 404 "no such route", for a `*` key and for a scoped key
//   Scenario: a key scoped out of the vault gets 403 that names `vault:read`
//   Scenario: a `*` key lists the grant ask in GET /api/vault and grants it, recorded as the key
//   Scenario: a `*` key denies a grant ask, recorded as the key
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { rawRequest } from '../support/http.ts';
import { boxes, helper } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'k3s-token-0123456789abcdef-never-on-disk';
const KEY_BY = /^cos-key \(API token of .+\)$/;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
  });
  return { a: t, session: await t.login() };
}

/** A job on a box of the template kube that asked the vault for KUBE_TOKEN with no grant: a grant ask. */
async function asking(a: TestApp, session: string): Promise<{ job: Job; dir: string }> {
  const edit = (body: Record<string, unknown>) => a.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'KUBE_TOKEN', value: VALUE });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  await edit({ action: 'approve-template', name: 'kube' });
  const dir = await box.join(a, session, 'hopper-sandbox-kube', 'kube');
  const job = await a.waitForStatus((await a.pull({ op: 'sleep', ms: 60000 })).id, 'running', 10000);
  expect((await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, job.id))).stderr).toMatch(/has no vault grant/);
  return { job, dir };
}

/** An API token of a grant of these scopes, labelled cos-key, traded from its refresh token. */
async function keyOf(a: TestApp, session: string, scopes: string[]): Promise<string> {
  const minted = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'cos-key', scopes, days: 30 }, { token: session });
  expect(minted.status, JSON.stringify(minted.body)).toBe(200);
  const r = await rawRequest(a.url, { method: 'POST', path: '/ui/auth/token/refresh', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: (minted.body as { refresh: string }).refresh }) });
  expect(r.status, r.text).toBe(200);
  return (JSON.parse(r.text) as { token: string }).token;
}

async function call(a: TestApp, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> {
  const r = await rawRequest(a.url, {
    method, path, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined };
}

describe('the owner\'s no-limits key on Access requests (issue #2229)', () => {
  it('an unknown route answers 404 no such route; a key scoped out of the vault gets 403 that names vault:read', async () => {
    const { a, session } = await boot();
    const all = await keyOf(a, session, ['*']);
    const scoped = await keyOf(a, session, ['questions:read']);
    for (const token of [all, scoped]) {
      for (const [method, path] of [['GET', '/api/access-requests'], ['GET', '/api/vault/requests'], ['POST', '/ui/api/access-requests/x/grant']] as const) {
        const r = await call(a, method, path, token, method === 'POST' ? {} : undefined);
        expect(r.status, `${method} ${path}: ${r.text}`).toBe(404);
        expect(r.body.error).toMatch(/^no such route: /);
        expect(r.text).not.toMatch(/scope/);
      }
    }
    const refused = await call(a, 'GET', '/api/vault', scoped);
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.error).toMatch(/do not cover vault:read/);
    const refusedGrant = await call(a, 'POST', '/ui/api/jobs/x/grant-vault', scoped, {});
    expect(refusedGrant.status, refusedGrant.text).toBe(403);
    expect(refusedGrant.body.error).toMatch(/do not cover jobs:grant-vault/);
  });

  it('a * key lists the grant ask and grants it, recorded as the key', async () => {
    const { a, session } = await boot();
    const { job, dir } = await asking(a, session);
    const token = await keyOf(a, session, ['*']);

    const listed = await call(a, 'GET', '/api/vault', token);
    expect(listed.status, listed.text).toBe(200);
    expect(listed.body).toMatchObject({ grantAsks: [expect.objectContaining({ job: job.id, template: 'kube' })], requests: [], sandboxRequests: [] });

    const granted = await call(a, 'POST', `/ui/api/jobs/${job.id}/grant-vault`, token, {});
    expect(granted.status, granted.text).toBe(200);
    expect(granted.body.grantAsks).toEqual([]);
    expect(granted.body.grants).toEqual([expect.objectContaining({ job: job.id, by: expect.stringMatching(KEY_BY) })]);
    expect((await a.events()).find((e) => e.type === 'vault.granted')).toMatchObject({ jobId: job.id, data: { by: expect.stringMatching(KEY_BY) } });
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, job.id))).toMatchObject({ code: 0, stdout: VALUE });
  });

  it('a * key denies a grant ask, recorded as the key', async () => {
    const { a, session } = await boot();
    const { job } = await asking(a, session);
    const token = await keyOf(a, session, ['*']);

    const denied = await call(a, 'POST', `/ui/api/jobs/${job.id}/deny-vault`, token, {});
    expect(denied.status, denied.text).toBe(200);
    expect(denied.body.grantAsks).toEqual([]);
    expect(denied.body.grants ?? []).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.grant_denied')).toMatchObject({ jobId: job.id, data: { job: job.id, by: expect.stringMatching(KEY_BY) } });
  });
});
