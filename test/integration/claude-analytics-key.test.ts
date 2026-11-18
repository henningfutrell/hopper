// Issue #2966, through the real composition root and the real HTTP server, against a fake Analytics API on loopback: the
// Claude Analytics API key is the hopper's own secret. An admin sets it on Usage or by the operator CLI; it is checked once
// against the Analytics API at the `baseUrl` of the user's `claude-analytics` source, and kept in the vault's system
// scope — sealed under the master key, never answered back, never in an event —.
//
// Feature: the analytics key
//   Scenario: an admin sets the key: one check against the API, kept, shown as set with its last 4 characters
//   Scenario: a key the API refuses is not kept, and the error masks it
//   Scenario: remove deletes it; a second remove is a 404
//   Scenario: an operator cannot set it: the key reads a whole organization's usage
//   Scenario: the operator CLI sets the key from stdin, shows it and removes it, as JSON
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { AnalyticsKeyView } from '../../src/domain/types.ts';
import { openDb } from '../../src/store/db.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';
import { startFakeAnalytics, type FakeAnalytics } from '../plugins/fake-claude-analytics.ts';

const GOOD = 'sk-ant-admin01-analytics-good-0123456789-wxyz';
const BAD = 'sk-ant-admin01-analytics-bad-0123456789-nope';

let t: TestApp | undefined;
let api: FakeAnalytics | undefined;
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
  await api?.close();
  api = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

async function boot(): Promise<{ a: TestApp; session: string; api: FakeAnalytics }> {
  api = await startFakeAnalytics();
  api.key = GOOD;
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({
    dbPath: db.dbPath, seams: { authorizationServer: createFakeAuthorizationServer() }, secrets: { HOPPER_MASTER_KEY: KEY },
    plugins: { machines: lanes(1), usageSources: [{ name: 'analytics', plugin: 'claude-analytics', options: { baseUrl: api.url } }] },
  });
  return { a: t, session: await t.login(), api };
}

type Answer = AnalyticsKeyView & { error?: string };
const setKey = (a: TestApp, token: string, value: string) => a.ui<Answer>('/ui/api/claude-analytics-key', { action: 'set', value }, { token });
const removeKey = (a: TestApp, token: string) => a.ui<Answer>('/ui/api/claude-analytics-key', { action: 'remove' }, { token });
const view = async (a: TestApp): Promise<AnalyticsKeyView> => (await a.api<AnalyticsKeyView>('GET', '/api/claude-analytics-key')).body;

/** Nothing the hopper answered, logged, appended or stored in clear carries `value`. */
async function nowhere(a: TestApp, value: string): Promise<void> {
  for (const path of ['/api/claude-analytics-key', '/api/usage', '/api/vault', '/api/events?limit=1000']) expect(JSON.stringify((await a.api('GET', path)).body)).not.toContain(value);
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try { expect(JSON.stringify(db.all('SELECT * FROM vault_secrets'))).not.toContain(value); } finally { db.close(); }
  expect(logged.join('\n')).not.toContain(value);
}

describe('the analytics key (issue #2966)', () => {
  it('an admin sets the key: one check against the API, kept, shown as set with its last 4 characters', async () => {
    const { a, session, api } = await boot();
    expect(await view(a)).toEqual({ set: false });
    const r = await setKey(a, session, `  ${GOOD}\n`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ set: true, last4: 'wxyz', setAt: expect.any(String), setBy: expect.any(String) });
    expect(await view(a)).toMatchObject({ set: true, last4: 'wxyz' });
    // The check: one page of one user of the users endpoint, with the key, at the source's baseUrl.
    const checks = api.seen.filter((s) => s.headers['x-api-key'] === GOOD);
    expect(checks.length).toBeGreaterThanOrEqual(1);
    expect(checks[0]).toMatchObject({ path: '/v1/organizations/analytics/users' });
    expect(checks[0]!.query.get('limit')).toBe('1');
    const set = (await a.events('types=vault.secret_set&limit=100')).map((e) => e.data);
    expect(set).toContainEqual(expect.objectContaining({ name: 'system/claude-analytics-key' }));
    await nowhere(a, GOOD);
  });

  it('a key the API refuses is not kept, and the error masks it', async () => {
    const { a, session } = await boot();
    const r = await setKey(a, session, BAD);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/the key was not saved: the check against the Analytics API failed: the Analytics API refused the key \(HTTP 401\)/);
    expect(r.body.error).not.toContain(BAD);
    expect(await view(a)).toEqual({ set: false });
    expect((await setKey(a, session, '   ')).status).toBe(400);
    await nowhere(a, BAD);
  });

  it('a day the API has not made yet still passes the check: the 400 means it took the key', async () => {
    const { a, session, api } = await boot();
    api.newestDay = '2000-01-01';
    expect((await setKey(a, session, GOOD)).status).toBe(200);
  });

  it('remove deletes it; a second remove is a 404', async () => {
    const { a, session } = await boot();
    await setKey(a, session, GOOD);
    const r = await removeKey(a, session);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ set: false });
    expect((await removeKey(a, session)).status).toBe(404);
  });

  it('an operator cannot set it: the key reads a whole organization\'s usage', async () => {
    const { a } = await boot();
    const r = await setKey(a, await sessionAs(a, 'operator'), GOOD);
    expect(r.status).toBe(403);
    expect(await view(a)).toEqual({ set: false });
  });

  it('the operator CLI sets the key from stdin, shows it and removes it, as JSON', async () => {
    const { a } = await boot();
    const set = await hopper(a, ['claude-analytics-key', 'set'], `${GOOD}\n`);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({ set: true, last4: 'wxyz' });
    expect(set.out).not.toContain(GOOD);
    expect(JSON.parse((await hopper(a, ['claude-analytics-key'])).out)).toMatchObject({ set: true, last4: 'wxyz' });
    expect((await hopper(a, ['claude-analytics-key', 'set', GOOD])).err).toMatch(/usage: hopper claude-analytics-key set .*stdin/);
    expect((await hopper(a, ['claude-analytics-key', 'set'], '')).code).toBe(2);
    const bad = await hopper(a, ['claude-analytics-key', 'set'], BAD);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/the check against the Analytics API failed/);
    expect(bad.err).not.toContain(BAD);
    expect(JSON.parse((await hopper(a, ['claude-analytics-key', 'remove'])).out)).toEqual({ set: false });
    await nowhere(a, GOOD);
  });
});

/** A session of the admin user with `role`, minted as the operator CLI mints one. */
async function sessionAs(a: TestApp, role: 'viewer' | 'operator'): Promise<string> {
  const { createUiSessions } = await import('../../src/http/ui/sessions.ts');
  const { loadSignInConfig } = await import('../../src/auth/index.ts');
  const instance = a.app.instance;
  const sessions = createUiSessions({
    repo: instance.uiSessions, clock: { now: () => new Date() },
    signIn: { config: () => loadSignInConfig(instance.signInConfig.read()), checkGateway: async () => ({ ok: false as const, status: 403 as const, error: 'none' }) },
  });
  return sessions.create({ role, identity: { realm: 'cli', subject: role, name: role, groups: [] }, userId: 'admin', lastsMs: 60_000 }).token;
}

async function hopper(a: TestApp, argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => stdin, out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}
