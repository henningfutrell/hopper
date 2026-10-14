// Issue #881: a person mints a scoped grant once; the agent it is for (Grok Bot) keeps acting unattended, trading its
// refresh token for short-lived API tokens, each time for a new refresh token. A grant's tokens use only the routes
// its scopes cover; box actions need the box flag too. Revoke in the UI stops it at once. The admin sets how long an
// API token lives. Real daemon, real HTTP server; OpenFGA and the container runtime are doubles at their ports.
//
// Feature: grants and refresh tokens
//   Scenario: a person mints a box grant for Grok Bot; it refreshes again and again, answers questions and approves intake
//     Given a hopper with OpenFGA
//     When the admin mints a grant held by grok-bot with scopes questions:answer, sources:intake and *:read, as a box grant
//     Then the answer holds an API token and a refresh token, and the list holds neither
//     And each refresh answers a new pair; the API token reads, and answers questions and acts on intake
//     And a route outside its scopes is refused, naming the scope
//     And a refresh retried at once gets the same pair
//     And every mint and refresh is an event of the user's
//   Scenario: a grant without the box flag may not do a box action, whatever its scopes
//   Scenario: revoked in the UI, the grant's API token and refresh token stop at once
//   Scenario: a mint names scopes the routes have, and a lifetime the admin allows
//   Scenario: the admin sets the API-token lifetime, 5 to 15 minutes
//   Scenario: a grant from a preset (issue #909): the agent reads the registry and what Needs you shows, and acts on
//     intake as a box grant, with no scope typed and no box flag named; an unknown preset is refused
//   Scenario: a grant that holds one action of a route (issue #909): it does that action, and is refused the others,
//     naming the action's scope
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { rawRequest } from '../support/http.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(1) },
    seams: { containerRuntime: createFakeContainerRuntime(), authorizationServer: createFakeAuthorizationServer() },
  });
  return t;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };
const parsed = (r: { status: number; text: string }): Answer => ({ status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined });

async function agent(a: TestApp, method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<Answer> {
  return parsed(await rawRequest(a.url, {
    method, path, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

const refresh = async (a: TestApp, token: string): Promise<Answer> =>
  parsed(await rawRequest(a.url, { method: 'POST', path: '/ui/auth/token/refresh', body: JSON.stringify({ refresh: token }), headers: { 'content-type': 'application/json' } }));

async function mint(a: TestApp, session: string, body: Record<string, unknown> = {}): Promise<Answer> {
  const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'Grok Bot', holder: 'grok-bot', ...body }, { token: session });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body) };
}

const GROK = ['questions:answer', 'sources:intake', '*:read'];

describe('grants and refresh tokens (issue #881)', () => {
  it('a person mints a box grant once; the agent refreshes again and again and acts within its scopes', async () => {
    const a = await boot();
    const session = await a.login();
    const minted = await mint(a, session, { scopes: GROK, box: true, role: 'operator' });
    expect(minted.status, minted.text).toBe(200);
    expect(minted.body).toMatchObject({
      grant: expect.stringMatching(/^[0-9a-f]{16}$/), token: expect.stringMatching(/^hopper_at_/), refresh: expect.stringMatching(/^hopper_rt_[0-9a-f]{64}$/),
      view: { label: 'Grok Bot', holder: 'grok-bot', role: 'operator', box: true, scopes: ['*:read', 'questions:answer', 'sources:intake'] },
    });
    const listed = await a.api('GET', '/api/api-tokens', undefined, { 'x-hopper-session': session });
    expect(listed.body.grants).toEqual([expect.objectContaining({ id: minted.body.grant, holder: 'grok-bot' })]);
    expect(listed.body.scopes).toEqual(expect.arrayContaining(['questions:answer', 'sources:intake', 'jobs:approve', 'queue:read']));
    expect(listed.body.settings).toEqual({ tokenMinutes: 10, min: 5, max: 15 });
    expect(JSON.stringify(listed.body)).not.toContain(minted.body.refresh);
    expect(JSON.stringify(listed.body)).not.toContain(minted.body.token);

    // Days of unattended work, compressed: refresh after refresh, each with the refresh token the last one gave.
    let pair = { token: minted.body.token as string, refresh: minted.body.refresh as string };
    for (let i = 0; i < 3; i++) {
      const r = await refresh(a, pair.refresh);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ grant: minted.body.grant, token: expect.stringMatching(/^hopper_at_/), refresh: expect.stringMatching(/^hopper_rt_/) });
      expect(r.body.refresh).not.toBe(pair.refresh);
      pair = { token: r.body.token, refresh: r.body.refresh };
    }
    expect((await agent(a, 'GET', '/api/queue', pair.token)).status).toBe(200);
    // In scope: the route answers for itself (no such question, no such source), not the scope.
    const answered = await agent(a, 'POST', '/ui/api/questions/nope/answer', pair.token, { answer: 'yes' });
    expect(answered.status, answered.text).toBe(404);
    const intake = await agent(a, 'POST', '/ui/api/sources/nope/intake', pair.token, { kind: 'approve', keys: ['nope#1'] });
    expect(intake.body?.error ?? '').not.toMatch(/scope/);
    // Out of scope: refused, naming the scope it needs.
    const order = await agent(a, 'POST', '/ui/api/queue/order', pair.token, { jobIds: [] });
    expect(order.status).toBe(403);
    expect(order.body.error).toMatch(/do not cover queue:order/);

    // A retry of the last refresh at once gets the same pair: a network blip loses nothing.
    const last = await refresh(a, pair.refresh);
    const retried = await refresh(a, pair.refresh);
    expect(retried.body).toEqual(last.body);

    const events = await a.api('GET', '/api/events?limit=50', undefined, { 'x-hopper-session': session });
    const types = (events.body.events as { type: string }[]).map((e) => e.type);
    expect(types.filter((x) => x === 'api_grant.minted')).toHaveLength(1);
    expect(types.filter((x) => x === 'api_grant.refreshed')).toHaveLength(4);
    expect(JSON.stringify(events.body)).not.toContain(pair.refresh);
  });

  it('a grant from a preset reads the registry and Needs you, and acts on intake as a box grant (issue #909)', async () => {
    const a = await boot();
    const session = await a.login();
    const registry = await a.api('GET', '/api/scopes', undefined, { 'x-hopper-session': session });
    expect(registry.status).toBe(200);
    const intake = registry.body.presets.find((p: { id: string }) => p.id === 'agent-intake');
    expect(intake).toMatchObject({ scopes: ['*:read', 'sources:intake'], box: true });
    const section = registry.body.sections.find((s: { id: string }) => s.id === 'intake');
    expect(section.permissions).toContainEqual(expect.objectContaining({ scope: 'sources:intake', routes: ['POST /ui/api/sources/:name/intake'], box: true, role: 'operator' }));

    expect((await mint(a, session, { preset: 'nope' })).body.error).toMatch(/no preset "nope"/);
    expect((await mint(a, session, {})).body.error).toMatch(/at least one scope, or a preset/);
    const minted = await mint(a, session, { preset: 'agent-intake', role: 'operator' });
    expect(minted.status, minted.text).toBe(200);
    expect(minted.body.view).toMatchObject({ scopes: ['*:read', 'sources:intake'], box: true });
    for (const read of ['/api/scopes', '/api/sources', '/api/vault', '/api/queue', '/api/sections']) expect((await agent(a, 'GET', read, minted.body.token)).status, read).toBe(200);
    const acted = await agent(a, 'POST', '/ui/api/sources/nope/intake', minted.body.token, { kind: 'approve', keys: ['nope#1'] });
    expect(acted.body?.error ?? '').not.toMatch(/scope|box token/);
    expect((await agent(a, 'POST', '/ui/api/jobs/nope/approve', minted.body.token, {})).body.error).toMatch(/do not cover jobs:approve/);
    // A preset and scopes of its own: the grant holds both; `box` named wins over the preset's.
    const both = await mint(a, session, { preset: 'read-only', scopes: ['questions:answer'], box: false });
    expect(both.body.view).toMatchObject({ scopes: ['*:read', 'questions:answer'], box: false });
  });

  it('a grant that holds one action of a route does that action only (issue #909)', async () => {
    const a = await boot();
    const session = await a.login();
    const registry = await a.api('GET', '/api/scopes', undefined, { 'x-hopper-session': session });
    const intake = registry.body.sections.find((s: { id: string }) => s.id === 'intake');
    expect(intake.permissions).toContainEqual(expect.objectContaining({ scope: 'sources:intake.approve', parent: 'sources:intake', routes: ['POST /ui/api/sources/:name/intake (kind: approve)'], box: true }));

    const minted = await mint(a, session, { scopes: ['*:read', 'sources:intake.approve', 'vault:edit.decline-credential'], box: true });
    expect(minted.status, minted.text).toBe(200);
    expect(minted.body.view.scopes).toEqual(['*:read', 'sources:intake.approve', 'vault:edit.decline-credential']);
    const token = minted.body.token as string;
    // Its action: the route answers for itself, not the scope.
    const approved = await agent(a, 'POST', '/ui/api/sources/nope/intake', token, { kind: 'approve', keys: ['nope#1'], hash: 'a'.repeat(64) });
    expect(approved.body?.error ?? '', approved.text).not.toMatch(/scope|box token/);
    const declined = await agent(a, 'POST', '/ui/api/vault', token, { action: 'decline-credential', request: 'nope', reason: 'no' });
    expect(declined.body?.error ?? '', declined.text).not.toMatch(/scope/);
    // Another action of the same route: refused, naming its scope.
    const assigned = await agent(a, 'POST', '/ui/api/sources/nope/intake', token, { kind: 'assign', keys: ['nope#1'] });
    expect(assigned.status).toBe(403);
    expect(assigned.body.error).toMatch(/do not cover sources:intake\.assign/);
    const set = await agent(a, 'POST', '/ui/api/vault', token, { action: 'set', name: 'X', value: 'y' });
    expect(set.status).toBe(403);
    expect(set.body.error).toMatch(/do not cover vault:edit\.set/);
    // A body with no action: the route's own scope.
    expect((await agent(a, 'POST', '/ui/api/vault', token, {})).body.error).toMatch(/do not cover vault:edit$/);
    // A route none of whose actions it holds: refused at the door.
    expect((await agent(a, 'POST', '/ui/api/webhooks', token, { action: 'remove', id: 'nope' })).body.error).toMatch(/do not cover webhooks:edit/);
    expect((await mint(a, session, { scopes: ['vault:edit.nope'] })).body.error).toMatch(/names no route/);
  });

  it('a grant without the box flag may not do a box action, whatever its scopes', async () => {
    const a = await boot();
    const minted = await mint(a, await a.login(), { scopes: ['*'] });
    const r = await agent(a, 'POST', '/ui/api/jobs/nope/approve', minted.body.token, {});
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/box token/);
  });

  it('revoked in the UI, the grant\'s API token and refresh token stop at once', async () => {
    const a = await boot();
    const session = await a.login();
    const minted = await mint(a, session, { scopes: ['*:read'] });
    expect((await agent(a, 'GET', '/api/queue', minted.body.token)).status).toBe(200);
    const revoked = await a.ui<{ grants: unknown[] }>('/ui/api/api-tokens', { action: 'revoke', id: minted.body.grant }, { token: session });
    expect(revoked.body.grants).toEqual([]);
    expect((await agent(a, 'GET', '/api/queue', minted.body.token)).status).toBe(401);
    expect((await refresh(a, minted.body.refresh)).status).toBe(401);

    // Revoke all: every grant of the user.
    const one = await mint(a, session, { scopes: ['*:read'] });
    const two = await mint(a, session, { scopes: ['*:read'] });
    expect((await a.ui<{ grants: unknown[] }>('/ui/api/api-tokens', { action: 'revoke-all' }, { token: session })).body.grants).toEqual([]);
    expect((await refresh(a, one.body.refresh)).status).toBe(401);
    expect((await agent(a, 'GET', '/api/queue', two.body.token)).status).toBe(401);
    const events = await a.api('GET', '/api/events?limit=50&types=api_grant.revoked', undefined, { 'x-hopper-session': session });
    expect((events.body.events as { data: { reason: string } }[]).map((e) => e.data.reason).sort()).toEqual(['revoked', 'revoked-all', 'revoked-all']);
  });

  it('a mint names scopes the routes have, and a lifetime the admin allows', async () => {
    const a = await boot();
    const session = await a.login();
    expect((await mint(a, session, { scopes: [] })).status).toBe(400);
    expect((await mint(a, session, { scopes: ['admin'] })).body.error).toMatch(/write <area>:<act>/);
    expect((await mint(a, session, { scopes: ['nothing:here'] })).body.error).toMatch(/names no route/);
    expect((await mint(a, session, { scopes: ['*'], minutes: 4 })).status).toBe(400);
    expect((await mint(a, session, { scopes: ['*'], days: 0 })).status).toBe(400);
    // An admin may mint one with no fixed end, with a warning.
    const forever = await mint(a, session, { scopes: ['*:read'], days: null });
    expect(forever.status).toBe(200);
    expect(forever.body.view.endsAt).toBeNull();
    expect(forever.body.warning).toMatch(/no fixed end/);
  });

  it('the admin sets the API-token lifetime, 5 to 15 minutes; a grant\'s tokens live that long', async () => {
    const a = await boot();
    const session = await a.login();
    for (const bad of [4, 16, 7.5]) expect((await a.ui('/ui/api/api-tokens/settings', { tokenMinutes: bad }, { token: session })).status).toBe(400);
    const set = await a.ui('/ui/api/api-tokens/settings', { tokenMinutes: 5 }, { token: session });
    expect(set.body).toEqual({ tokenMinutes: 5, min: 5, max: 15 });
    const before = Date.now();
    const minted = await mint(a, session, { scopes: ['*:read'] });
    expect(Date.parse(minted.body.expiresAt)).toBeLessThanOrEqual(before + 5 * 60_000 + 1000);
    expect(Date.parse(minted.body.expiresAt)).toBeGreaterThan(before + 4 * 60_000);
    expect((await mint(a, session, { scopes: ['*:read'], minutes: 6 })).body.error).toMatch(/at most 5 minutes/);
    // A grant's token may not change the setting unless its scope covers it.
    const read = minted.body.token as string;
    expect((await agent(a, 'POST', '/ui/api/api-tokens/settings', read, { tokenMinutes: 15 })).status).toBe(403);
  });
});
