// Issue #657, through the real composition root, the real HTTP server and the real Jev (jev_pick.py, with the fake
// typesafe_sdk on PYTHONPATH): the TypeSafe API key is the hopper's own secret. It is set on the Jev page (Settings →
// Minor decisions) or by the operator CLI, checked once against TypeSafe, and kept in the vault's system scope — sealed
// under the token key, never listed, never answered back, never given to a job —; Jev reads it at each decision, so
// a set, a replace or a removal applies without a restart. A key still in the environment is imported once, with a note.
//
// Feature: the TypeSafe API key, set in the UI
//   Scenario: a key saved in the UI turns Jev on without a restart; the page shows "set" and its last 4 characters
//   Scenario: no answer, event, log line or database row carries the key in clear
//   Scenario: a bad key shows TypeSafe's error, masked, and does not turn Jev on
//   Scenario: a key in the environment and none stored: imported once, with a note; a later removal is not undone
//   Scenario: removing the key turns Jev off at once
//   Scenario: Access decides: OpenFGA not reached, nothing changes; a job's ask for the key is refused
//   Scenario: the operator CLI sets the key from stdin and removes it, as JSON
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { DomainEvent, MinorDecisionsView } from '../../src/domain/types.ts';
import { openDb } from '../../src/store/db.ts';
import { createFakeAuthorizationServer, type FakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const FAKE_TYPESAFE = join(import.meta.dirname, '..', 'plugins', 'fixtures', 'fake-typesafe');
const GOOD = 'ts-good-0123456789abcdef-wxyz';
const OTHER = 'ts-good-fedcba9876543210-qrst';
const BAD = 'ts-bad-0123456789abcdef-nope';
const PICK = 'Which name should the new module take?\n1. ledger\n2. journal';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

async function boot(o: { secrets?: Record<string, string>; dbPath?: string; fga?: FakeAuthorizationServer } = {}): Promise<{ a: TestApp; session: string; fga: FakeAuthorizationServer }> {
  let dbPath = o.dbPath;
  if (!dbPath) {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    dbPath = db.dbPath;
  }
  const fga = o.fga ?? createFakeAuthorizationServer();
  t = await startTestApp({
    dbPath, plugins: { machines: lanes(1) }, seams: { authorizationServer: fga },
    secrets: { HOPPER_TOKEN_KEY: KEY, PYTHONPATH: FAKE_TYPESAFE, ...o.secrets },
  });
  return { a: t, session: await t.login(), fga };
}

type KeyView = MinorDecisionsView['typesafeKey'];
const view = async (a: TestApp): Promise<MinorDecisionsView> => (await a.api<MinorDecisionsView>('GET', '/api/minor-decisions')).body;
const setKey = (a: TestApp, session: string, value: string) => a.ui<KeyView & { error?: string }>('/ui/api/typesafe-key', { action: 'set', value }, { token: session });
const removeKey = (a: TestApp, session: string) => a.ui<KeyView & { error?: string }>('/ui/api/typesafe-key', { action: 'remove' }, { token: session });
const picked = async (a: TestApp, jobId: string): Promise<DomainEvent[]> =>
  (await a.events('types=minor_decision.picked&limit=1000')).filter((e) => e.jobId === jobId);

/** The vault's table as the database holds it. */
function rows(a: TestApp): Record<string, unknown>[] {
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try { return db.all('SELECT * FROM vault_secrets ORDER BY seq'); } finally { db.close(); }
}

/** Nothing the hopper answered, logged, appended or stored in clear carries `value`. */
async function nowhere(a: TestApp, value: string): Promise<void> {
  for (const path of ['/api/minor-decisions', '/api/vault', '/api/events?limit=1000']) expect(JSON.stringify((await a.api('GET', path)).body)).not.toContain(value);
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(JSON.stringify(rows(a))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
}

describe('the TypeSafe API key, set in the UI', () => {
  it('a key saved in the UI turns Jev on without a restart; the page shows "set" and its last 4 characters', async () => {
    const { a, session } = await boot();
    expect((await view(a)).jev).toEqual({ available: false, why: 'Jev is off until a TypeSafe API key is set' });
    expect((await view(a)).typesafeKey).toEqual({ set: false });
    const r = await setKey(a, session, GOOD);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ set: true, last4: 'wxyz', setBy: expect.any(String), setAt: expect.any(String) });
    const v = await view(a);
    expect(v.jev).toEqual({ available: true });
    expect(v.typesafeKey).toMatchObject({ set: true, last4: 'wxyz' });
    // Jev is asked at the next decision, with the key, through TypeSafe: no restart.
    const job = await a.pull({ op: 'ask', message: PICK });
    await a.waitForStatus(job.id, 'finished');
    const [pick] = await picked(a, job.id);
    expect(pick!.data).toMatchObject({ by: 'jev', pick: '1', confidence: 0.9 });
    // Kept in the vault's system scope: sealed, and not one of the vault's own secrets.
    expect(rows(a)).toHaveLength(1);
    expect(rows(a)[0]).toMatchObject({ name: 'system/typesafe-api-key' });
    expect((await a.api('GET', '/api/vault')).body.secrets).toEqual([]);
    // Replace: the new key, from the next decision.
    expect((await setKey(a, session, OTHER)).body).toMatchObject({ set: true, last4: 'qrst' });
    await nowhere(a, GOOD);
    await nowhere(a, OTHER);
  });

  it('a bad key shows TypeSafe\'s error, masked, and does not turn Jev on', async () => {
    const { a, session } = await boot();
    const r = await setKey(a, session, BAD);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/TypeSafe refused the key: .*401 invalid api key/);
    expect(r.body.error).not.toContain(BAD);
    expect((await view(a)).jev.available).toBe(false);
    expect((await view(a)).typesafeKey).toEqual({ set: false });
    expect(rows(a)).toEqual([]);
    // A good key stored stays when a bad one is offered in its place.
    await setKey(a, session, GOOD);
    expect((await setKey(a, session, BAD)).status).toBe(400);
    expect((await view(a)).typesafeKey).toMatchObject({ set: true, last4: 'wxyz' });
    await nowhere(a, BAD);
    await nowhere(a, GOOD);
  });

  it('removing the key turns Jev off at once', async () => {
    const { a, session } = await boot();
    await setKey(a, session, GOOD);
    const r = await removeKey(a, session);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ set: false });
    expect((await view(a)).jev).toEqual({ available: false, why: 'Jev is off until a TypeSafe API key is set' });
    const job = await a.pull({ op: 'ask', message: PICK });
    await a.waitForStatus(job.id, 'finished');
    expect(await picked(a, job.id)).toEqual([]);
    expect((await a.events('types=vault.secret_set,vault.secret_removed')).map((e) => [e.type, e.data.name])).toEqual([
      ['vault.secret_set', 'system/typesafe-api-key'], ['vault.secret_removed', 'system/typesafe-api-key'],
    ]);
    expect((await removeKey(a, session)).status).toBe(404);
  });

  it('a key in the environment and none stored: imported once, with a note; a later removal is not undone', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const { a, session } = await boot({ dbPath: db.dbPath, secrets: { TYPESAFE_API_KEY: GOOD } });
    const v = await view(a);
    expect(v.jev).toEqual({ available: true });
    expect(v.typesafeKey).toMatchObject({ set: true, last4: 'wxyz', environment: { variable: 'TYPESAFE_API_KEY' } });
    expect(logged.join('\n')).toMatch(/TYPESAFE_API_KEY: the TypeSafe API key is imported from the environment into the vault; remove it from the environment/);
    // Removed in the UI, and the hopper started again with the variable still set: it is not imported again.
    await removeKey(a, session);
    await t!.stop();
    t = undefined;
    const again = await boot({ dbPath: db.dbPath, secrets: { TYPESAFE_API_KEY: OTHER } });
    expect((await view(again.a)).typesafeKey).toEqual({ set: false, environment: { variable: 'TYPESAFE_API_KEY' } });
    expect((await view(again.a)).jev.available).toBe(false);
    await nowhere(again.a, GOOD);
    await nowhere(again.a, OTHER);
  });

  it('Access decides: OpenFGA not reached, nothing changes; the check names the user\'s system secret', async () => {
    const { a, session, fga } = await boot();
    expect((await setKey(a, session, GOOD)).status).toBe(200);
    const check = fga.checks.find((c) => c.tuple.object.startsWith('system_secret:'));
    expect(check?.tuple).toEqual({ subject: 'user:admin', relation: 'can_change', object: 'system_secret:admin/typesafe-api-key' });
    fga.reachable = false;
    const r = await removeKey(a, session);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/OpenFGA cannot be asked/);
    expect((await view(a)).typesafeKey).toMatchObject({ set: true });
  });

  it('a viewer cannot set it', async () => {
    const { a } = await boot();
    const r = await a.ui('/ui/api/typesafe-key', { action: 'set', value: GOOD }, { token: await viewerSession(a) });
    expect(r.status).toBe(403);
  });

  it('the operator CLI sets the key from stdin and removes it, as JSON', async () => {
    const { a } = await boot();
    const set = await hopper(a, ['typesafe-key', 'set'], `${GOOD}\n`);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({ set: true, last4: 'wxyz' });
    expect(set.out).not.toContain(GOOD);
    const shown = await hopper(a, ['typesafe-key', '--json']);
    expect(JSON.parse(shown.out)).toMatchObject({ set: true, last4: 'wxyz' });
    expect((await hopper(a, ['typesafe-key', 'set', GOOD])).err).toMatch(/usage: hopper typesafe-key set .*stdin/);
    expect((await hopper(a, ['typesafe-key', 'set'], '')).code).toBe(2);
    const bad = await hopper(a, ['typesafe-key', 'set'], BAD);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/TypeSafe refused the key/);
    expect(bad.err).not.toContain(BAD);
    const removed = await hopper(a, ['typesafe-key', 'remove']);
    expect(JSON.parse(removed.out)).toEqual({ set: false });
    await nowhere(a, GOOD);
  });
});

/** A session of the admin user with the viewer role, minted as the operator CLI mints one. */
async function viewerSession(a: TestApp): Promise<string> {
  const { createUiSessions } = await import('../../src/http/ui/sessions.ts');
  const { loadSignInConfig } = await import('../../src/auth/index.ts');
  const instance = a.app.instance;
  const sessions = createUiSessions({
    repo: instance.uiSessions, clock: { now: () => new Date() },
    signIn: { config: () => loadSignInConfig(instance.signInConfig.read()), checkGateway: async () => ({ ok: false as const, status: 403 as const, error: 'none' }) },
  });
  return sessions.create({ role: 'viewer', identity: { realm: 'cli', subject: 'viewer', name: 'viewer', groups: [] }, userId: 'admin', lastsMs: 60_000 }).token;
}

async function hopper(a: TestApp, argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => stdin, out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}
