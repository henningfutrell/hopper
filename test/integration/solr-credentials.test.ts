// Issue #2990, through the real composition root and the real HTTP server, against a fake Solr on loopback that asks for
// basic auth: the Solr credentials can be kept in the hopper's vault. The hopper's admin sets them on Settings → Search or
// by the operator CLI; they are checked once against Solr, kept as a system secret of the instance's vault, and sent on
// every Solr call from then on, so search leaves the `unauthorized` state. Never answered back, logged or in an event.
//
// Feature: the Solr credentials in the vault
//   Scenario: with no credentials, search is unauthorized; the admin sets them, and search is written again
//   Scenario: credentials Solr refuses are not kept, and the error names none
//   Scenario: an operator cannot set them
//   Scenario: the operator CLI sets them (the password on stdin), shows them and removes them, as JSON
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { SearchStatus, SolrCredentialsView } from '../../src/domain/search.ts';
import { openDb } from '../../src/store/db.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';
import { waitFor } from '../support/wait.ts';

const USER = 'hopper-app';
const PASSWORD = 'c0llection-pa55word';
const WRONG = 'wr0ng-pa55word';
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** A Solr core that answers only calls with the right basic auth: empty schema lists, no documents. */
async function fakeSolr(): Promise<{ url: string; seen: (string | undefined)[]; close(): Promise<void> }> {
  const seen: (string | undefined)[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers.authorization);
      if (req.headers.authorization !== basic(USER, PASSWORD)) { res.writeHead(401, { 'content-type': 'text/html' }).end('<h1>401</h1>'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ fieldTypes: [], fields: [], copyFields: [], response: { numFound: 0, docs: [] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/solr/hopper`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let t: TestApp | undefined;
let solr: Awaited<ReturnType<typeof fakeSolr>> | undefined;
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
  await solr?.close();
  solr = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  solr = await fakeSolr();
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, env: { HOPPER_SOLR_URL: solr.url }, seams: { authorizationServer: createFakeAuthorizationServer() }, secrets: { HOPPER_MASTER_KEY: KEY } });
  return { a: t, session: await t.login() };
}

type Answer = SolrCredentialsView & { error?: string };
const set = (a: TestApp, token: string, username: string, password: string) => a.ui<Answer>('/ui/api/solr-credentials', { action: 'set', username, password }, { token });
const view = async (a: TestApp): Promise<SolrCredentialsView> => (await a.api<SolrCredentialsView>('GET', '/api/solr-credentials')).body;
const status = async (a: TestApp): Promise<SearchStatus> => (await a.api<SearchStatus>('GET', '/api/search/status')).body;

/** Nothing the hopper answered, logged, appended or stored in clear carries `value`. */
async function nowhere(a: TestApp, value: string): Promise<void> {
  for (const path of ['/api/solr-credentials', '/api/search/status', '/api/vault', '/api/events?limit=1000']) expect(JSON.stringify((await a.api('GET', path)).body)).not.toContain(value);
  const db = openDb(ownerSchemaUrlFor(a.dbPath));
  try { expect(JSON.stringify(db.all('SELECT * FROM vault_secrets'))).not.toContain(value); } finally { db.close(); }
  expect(logged.join('\n')).not.toContain(value);
}

describe('the Solr credentials in the vault (issue #2990)', () => {
  it('with no credentials, search is unauthorized; the admin sets them, and search is written again', async () => {
    const { a, session } = await boot();
    expect(logged.join('\n')).toContain(`hopper: search: Solr at ${solr!.url}, basic auth off`);
    await waitFor(async () => (await status(a)).state === 'unauthorized', { timeoutMs: 20_000 });
    expect(await view(a)).toMatchObject({ configured: true, url: solr!.url, source: 'none', kept: { set: false } });
    const r = await set(a, session, USER, PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: 'vault', kept: { set: true } });
    await waitFor(async () => (await status(a)).state === 'ok', { timeoutMs: 20_000 });
    expect(solr!.seen.at(-1)).toBe(basic(USER, PASSWORD));
    const kept = (await a.events('types=vault.secret_set&limit=100')).map((e) => e.data);
    expect(kept).toContainEqual(expect.objectContaining({ name: 'system/solr-credentials' }));
    await nowhere(a, PASSWORD);
  });

  it('credentials Solr refuses are not kept, and the error names none', async () => {
    const { a, session } = await boot();
    const r = await set(a, session, USER, WRONG);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/the Solr credentials were not saved: .*401/);
    expect(await view(a)).toMatchObject({ source: 'none', kept: { set: false } });
    await nowhere(a, WRONG);
  });

  it('an operator cannot set them', async () => {
    const { a } = await boot();
    expect((await set(a, await sessionAs(a, 'operator'), USER, PASSWORD)).status).toBe(403);
    expect((await view(a)).kept).toEqual({ set: false });
  });

  it('the operator CLI sets them (the password on stdin), shows them and removes them, as JSON', async () => {
    const { a } = await boot();
    const r = await hopper(a, ['solr-credentials', 'set', '--username', USER], `${PASSWORD}\n`);
    expect(r).toMatchObject({ code: 0 });
    expect(JSON.parse(r.out)).toMatchObject({ source: 'vault', kept: { set: true } });
    expect(r.out).not.toContain(PASSWORD);
    expect(JSON.parse((await hopper(a, ['solr-credentials'])).out)).toMatchObject({ source: 'vault' });
    expect((await hopper(a, ['solr-credentials', 'set', '--username', USER, PASSWORD])).err).toMatch(/usage: hopper solr-credentials set .*stdin/);
    expect((await hopper(a, ['solr-credentials', 'set', '--username', USER], '')).code).toBe(2);
    expect(JSON.parse((await hopper(a, ['solr-credentials', 'remove'])).out)).toMatchObject({ source: 'none', kept: { set: false } });
  });
});

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
