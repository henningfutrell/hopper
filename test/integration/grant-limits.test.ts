// Issue #892: per-grant repository and job source limits, beside the scopes. A limited grant's tokens act only on jobs,
// questions, pull requests and items of the repositories and job sources it names; an act on anything else, or one the
// limits cannot place, is 403. Reads are not limited. Real daemon, real HTTP server; OpenFGA is a double at its port.
//
// Feature: grant limits
//   Scenario: a grant limited to a repository acts on its jobs, not on another repository's
//   Scenario: a limited grant may not use a route that names no repository or source
//   Scenario: intake and a direct job are placed by their source and repository
//   Scenario: a device grant request names its limits; the person sees them; the grant keeps them
//   Scenario: the mint checks the limits
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { rawRequest } from '../support/http.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };
const parsed = (r: { status: number; text: string }): Answer => ({ status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined });
async function post(a: TestApp, path: string, body: unknown, token?: string): Promise<Answer> {
  return parsed(await rawRequest(a.url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }));
}
async function mint(a: TestApp, extra: Record<string, unknown>): Promise<Answer & { session: string }> {
  const session = await a.login();
  const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'Grok Bot', holder: 'grok-bot', scopes: ['*'], ...extra }, { token: session });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body), session };
}
const jobOf = (a: TestApp, key: string, repo?: string, source = 'manual') =>
  a.user().store.jobs.create({ executor: 'test', payload: {}, goal: 'g' }, 50, { source, kind: source, key, ...(repo ? { repo } : {}) });

describe('grant limits (issue #892)', () => {
  it('a grant limited to a repository acts on its jobs, not on another repository\'s', async () => {
    const a = await boot();
    const m = await mint(a, { limits: { repos: ['Acme/App'] } });
    expect(m.status, m.text).toBe(200);
    expect(m.body.view.limits).toEqual({ repos: ['acme/app'] });
    const mine = jobOf(a, 'k-mine', 'acme/app');
    const theirs = jobOf(a, 'k-theirs', 'acme/other');
    const none = jobOf(a, 'k-none');

    const ok = await post(a, `/ui/api/jobs/${mine.id}/cancel`, {}, m.body.token);
    expect(ok.status, ok.text).toBe(200);
    for (const j of [theirs, none]) {
      const refused = await post(a, `/ui/api/jobs/${j.id}/cancel`, {}, m.body.token);
      expect(refused.status, refused.text).toBe(403);
      expect(refused.body.error).toMatch(/limited/);
      expect((await a.job(j.id)).status).not.toBe('cancelled');
    }
    // Reads are not limited: the scopes govern them.
    expect((await rawRequest(a.url, { method: 'GET', path: '/api/queue', headers: { authorization: `Bearer ${m.body.token}` } })).status).toBe(200);
    const listed = await a.api('GET', '/api/api-tokens', undefined, { 'x-hopper-session': m.session });
    expect(listed.body.grants).toEqual([expect.objectContaining({ id: m.body.grant, limits: { repos: ['acme/app'] } })]);
  });

  it('a limited grant may not use a route that names no repository or source; a grant with no limits may', async () => {
    const a = await boot();
    const limited = await mint(a, { limits: { sources: ['manual'] } });
    const refused = await post(a, '/ui/api/auto-park', {}, limited.body.token);
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body.error).toMatch(/names no repository or job source/);
    const free = await mint(a, {});
    expect((await post(a, '/ui/api/auto-park', {}, free.body.token)).status).not.toBe(403);
  });

  it('a job source limit places a job by its source; intake by its source and its items\' repositories', async () => {
    const a = await boot();
    const m = await mint(a, { limits: { sources: ['manual'] } });
    const manual = jobOf(a, 'k-1', 'acme/app', 'manual');
    const github = jobOf(a, 'https://github.com/acme/app/issues/2', 'acme/app', 'github');
    expect((await post(a, `/ui/api/jobs/${manual.id}/cancel`, {}, m.body.token)).status).toBe(200);
    expect((await post(a, `/ui/api/jobs/${github.id}/cancel`, {}, m.body.token)).status).toBe(403);
    const intake = await post(a, '/ui/api/sources/github/intake', { kind: 'dismiss', keys: ['https://github.com/acme/app/issues/2'] }, m.body.token);
    expect(intake.status, intake.text).toBe(403);
    expect(intake.body.error).toMatch(/github/);

    const byRepo = await mint(a, { limits: { repos: ['acme/app'] } });
    const other = await post(a, '/ui/api/sources/manual/intake', { kind: 'dismiss', keys: ['https://github.com/acme/app/issues/2', 'https://github.com/acme/other/issues/3'] }, byRepo.body.token);
    expect(other.status, other.text).toBe(403);
    expect(other.body.error).toMatch(/acme\/other/);
  });

  it('a device grant request names its limits; the person sees them; the grant keeps them', async () => {
    const a = await boot();
    const asked = await post(a, '/ui/auth/device-grant', { label: 'Grok Bot', scopes: ['*'], limits: { repos: ['acme/app'] } });
    expect(asked.status, asked.text).toBe(200);
    const session = await a.login();
    const seen = await a.api('GET', `/api/api-tokens/device/${asked.body.userCode}`, undefined, { 'x-hopper-session': session });
    expect(seen.body.ask.limits).toEqual({ repos: ['acme/app'] });
    expect((await a.ui('/ui/api/api-tokens', { action: 'approve-device', code: asked.body.userCode }, { token: session })).status).toBe(200);
    const granted = await post(a, '/ui/auth/device-grant/poll', { deviceCode: asked.body.deviceCode });
    expect(granted.status, granted.text).toBe(200);
    expect(granted.body.view.limits).toEqual({ repos: ['acme/app'] });
    const theirs = jobOf(a, 'k-theirs', 'acme/other');
    expect((await post(a, `/ui/api/jobs/${theirs.id}/cancel`, {}, granted.body.token)).status).toBe(403);
  });

  it('the mint checks the limits', async () => {
    const a = await boot();
    const bad = await mint(a, { limits: { repos: ['not-a-repo'] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/owner\/name/);
    const empty = await mint(a, { limits: { repos: [] } });
    expect(empty.status, empty.text).toBe(200);
    expect(empty.body.view.limits).toBeUndefined();
  });
});
