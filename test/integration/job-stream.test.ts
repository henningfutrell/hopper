// Issue #613, through the real composition root, the real HTTP server and a real joined client: the job stream. A job
// waits on its job stream for what a person must give, instead of asking again and again. The job runs the real
// `hopper-skill` (issue #582); the credential request is the dynamic vault's (issue #583). OpenFGA is a double at the
// AuthorizationServer seam.
//
// Feature: a job waits on the hopper's job stream, not by asking again
//   Scenario: the answer is pushed when the person gives the credential, with no second ask
//     Given the template web, approved, a box joined as web, and a job running on it
//     When the job runs `sh "$HOPPER_SKILL" example-api --credential "an API token" --wait`
//     Then the hopper opens a watch on the request and the job subscribes to GET /job/stream
//     When an admin gives the credential
//     Then the wait ends with how to use it; the job asked POST /job/skill once
//     And the job's stream holds skill.waiting, then skill.loaded, of that request
//   Scenario: a hopper restart in the middle of a wait loses nothing
//     When the hopper restarts while the job waits
//     Then the job reconnects with Last-Event-ID, the request is asked again, and the answer reaches the job
//   Scenario: a large answer arrives as a pointer; fetching it gives the object the event describes
//   Scenario: a wait past its deadline ends as expired
//   Scenario: the stream gives a job only its own events; a token that is no job's gets nothing
import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { StreamEvent } from '../../src/domain/job-stream.ts';
import type { CredentialRequest, VaultView } from '../../src/domain/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import type { AppSeams } from '../../src/main.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const VALUE = 'example-api-token-0123456789-never-shown';
const SERVICE = 'example-api';
const ASK = [SERVICE, '--credential', 'an API token'];

const apps: TestApp[] = [];
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

type Edit = (body: Record<string, unknown>) => Promise<{ status: number; body: VaultView }>;
interface Booted { a: TestApp; session: string; edit: Edit }

/** A hopper over `dbPath`: the template web, approved, with nothing in its scope, made on its first start. */
async function start(dbPath: string, o: { port?: number; seams?: AppSeams; first?: boolean } = {}): Promise<Booted> {
  const a = await startTestApp({
    dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, ...(o.port ? { env: { HOPPER_PORT: String(o.port) } } : {}),
    // Started again, the plugins config is the database's: it holds the box joined before.
    plugins: o.first === false ? false : { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer(), ...o.seams },
  });
  apps.push(a);
  const session = await a.login();
  const edit: Edit = async (body) => {
    const r = await a.ui<VaultView>('/ui/api/vault', body, { token: session });
    return { status: r.status, body: r.body };
  };
  if (o.first !== false) {
    await edit({ action: 'save-template', name: 'web', image: 'localhost/box-web:1', secrets: [] });
    await edit({ action: 'approve-template', name: 'web' });
  }
  return { a, session, edit };
}

function database(): string {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  return db.dbPath;
}

/** A machine joined as a box of web, and its client started. */
async function joinBox(a: TestApp, session: string, name: string): Promise<void> {
  const dir = temp('hopper-machine-');
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', { template: 'web' }, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await online(a, name);
}

const online = (a: TestApp, name: string): Promise<unknown> =>
  waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });

async function runningJob(a: TestApp, machine: string): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 120000 });
  expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe(`${machine}/lane-1`);
  return job.id;
}

/** The job's credentials dir: its proxy token and `hopper-skill`. */
function credentialsOf(a: TestApp, job: string): { dir: string; token: string } {
  const dir = temp('job-credentials-');
  const token = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);
  writeFileSync(join(dir, 'token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return { dir, token };
}

type Run = { code: number; stdout: string; stderr: string };
const env = (url: string, creds: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(creds, 'token'), TMPDIR: tmpdir() });

function run(url: string, creds: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: env(url, creds), encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

/** `hopper-skill … --wait` in the background: its end, when it comes. */
function waiting(url: string, creds: string, args: string[]): Promise<Run> {
  const child = spawn('sh', [join(creds, 'skill'), ...args, '--wait'], { env: env(url, creds) });
  cleanups.push(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr })));
}

async function requestFor(a: TestApp): Promise<CredentialRequest> {
  return waitFor(async () => ((await a.api('GET', '/api/vault')).body as VaultView).requests?.find((r) => r.skill === SERVICE), { timeoutMs: 10000, what: 'the credential request' });
}

/** What the job sees of one request on its stream: the stream closes after its ending event. */
async function streamOf(url: string, token: string, request?: string): Promise<{ status: number; events: Record<string, unknown>[]; text: string }> {
  const res = await fetch(`${url}/job/stream${request ? `?request=${request}` : ''}`, { headers: { authorization: `Bearer ${token}`, 'last-event-id': '0' } });
  const text = await res.text();
  return { status: res.status, text, events: text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>) };
}

/** A proxy in front of the hopper that counts the job's calls: no second ask may pass it. */
interface Seen { method: string; path: string; lastEventId?: string }
async function counting(port: () => number): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const id = req.headers['last-event-id'];
    seen.push({ method: req.method!, path: req.url!.split('?')[0]!, ...(typeof id === 'string' ? { lastEventId: id } : {}) });
    const up = request({ host: '127.0.0.1', port: port(), method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${port()}` } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
      // The hopper gone mid-stream: so is the job's connection, as it would be with no proxy between.
      r.on('close', () => { if (!r.complete) res.destroy(); });
    });
    up.on('error', () => { res.destroy(); });
    req.pipe(up);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const { port } = s.address() as AddressInfo;
  await new Promise((done) => s.close(done));
  return port;
}

const portOf = (a: TestApp): number => Number(new URL(a.url).port);
const requestOf = (r: Run): string => /^wait: (\S+) /m.exec(r.stderr)?.[1] ?? '';

describe('a job waits on its job stream (issue #613)', () => {
  it('the answer is pushed when the person gives the credential: one ask, no polling', async () => {
    const { a, session, edit } = await start(database());
    await joinBox(a, session, 'hopper-sandbox-web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const proxy = await counting(() => portOf(a));

    const wait = waiting(proxy.url, creds.dir, ASK);
    const r = await requestFor(a);
    await waitFor(() => proxy.seen.some((s) => s.path === '/job/stream'), { what: 'the job subscribed' });
    await new Promise((done) => setTimeout(done, 300));
    expect((await edit({ action: 'give-credential', request: r.id, name: SERVICE, kind: 'asked', value: VALUE })).status).toBe(200);

    const done = await wait;
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('Vault secret: example-api — an API token.');
    expect(done.stderr).toMatch(/^waiting: the hopper asked the user for an API token for example-api/);
    expect(done.stdout + done.stderr).not.toContain(VALUE);
    expect(proxy.seen.filter((s) => s.path === '/job/skill')).toHaveLength(1);

    const stream = await streamOf(a.url, creds.token, requestOf(done));
    expect(stream.status).toBe(200);
    expect(stream.events.map((e) => [e.type, e.phase, e.request])).toEqual([['skill.waiting', 'waiting', requestOf(done)], ['skill.loaded', 'done', requestOf(done)]]);
    expect(stream.text).not.toContain(VALUE);
  });

  it('a hopper restart in the middle of a wait loses nothing: the job reconnects with Last-Event-ID and gets the answer', async () => {
    const dbPath = database();
    const port = await freePort();
    const first = await start(dbPath, { port });
    await joinBox(first.a, first.session, 'hopper-sandbox-web');
    const job = await runningJob(first.a, 'hopper-sandbox-web');
    const creds = credentialsOf(first.a, job);
    const proxy = await counting(() => port);

    const wait = waiting(proxy.url, creds.dir, ASK);
    await requestFor(first.a);
    await waitFor(() => proxy.seen.some((s) => s.path === '/job/stream'), { what: 'the job subscribed' });
    await first.a.stop();
    apps.splice(apps.indexOf(first.a), 1);

    const second = await start(dbPath, { port, first: false });
    await online(second.a, 'hopper-sandbox-web');
    await second.a.waitForStatus(job, 'running', 15000);
    const r = await requestFor(second.a);
    expect(r.asked.map((x) => x.job)).toEqual([job]);
    expect((await second.edit({ action: 'give-credential', request: r.id, name: SERVICE, kind: 'asked', value: VALUE })).status).toBe(200);

    const done = await wait;
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('Vault secret: example-api — an API token.');
    expect(proxy.seen.filter((s) => s.path === '/job/skill')).toHaveLength(1);
    expect(proxy.seen.some((s) => s.path === '/job/stream' && s.lastEventId !== undefined && s.lastEventId !== '0')).toBe(true);
  });

  it('a large answer arrives as a pointer: fetching it gives the object the event describes', async () => {
    const { a, session, edit } = await start(database(), { seams: { jobStream: { inlineMax: 200 } } });
    await joinBox(a, session, 'hopper-sandbox-web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const wait = waiting(a.url, creds.dir, ASK);
    const r = await requestFor(a);
    expect((await edit({ action: 'give-credential', request: r.id, name: SERVICE, kind: 'asked', value: VALUE })).status).toBe(200);
    const done = await wait;
    expect(done.code).toBe(0);

    const stream = await streamOf(a.url, creds.token, requestOf(done));
    const pointer = stream.events.at(-1)!;
    expect(pointer).toMatchObject({ type: 'skill.loaded', phase: 'done', request: requestOf(done), ref: { url: `/job/stream/results/${String(pointer.seq)}` } });
    expect(pointer.payload).toBeUndefined();
    const res = await fetch(`${a.url}${(pointer.ref as { url: string }).url}`, { headers: { authorization: `Bearer ${creds.token}` } });
    const text = await res.text();
    expect(Buffer.byteLength(text)).toBe((pointer.ref as { bytes: number }).bytes);
    const result = JSON.parse(text) as StreamEvent;
    const { ref: _ref, ...described } = pointer;
    expect(result).toEqual({ ...described, payload: expect.any(String) });
    expect(`${result.payload as string}`.trimEnd()).toBe(done.stdout.trimEnd());

    const other = credentialsOf(a, await a.pull({ op: 'echo' }).then((j) => j.id));
    expect((await fetch(`${a.url}${(pointer.ref as { url: string }).url}`, { headers: { authorization: `Bearer ${other.token}` } })).status).not.toBe(200);
  });

  it('a wait past its deadline ends as expired, with a clear end state', async () => {
    const { a, session } = await start(database());
    await joinBox(a, session, 'hopper-sandbox-web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const done = await waiting(a.url, creds.dir, [...ASK, '--timeout', '1']);
    expect(done.code).toBe(4);
    expect(done.stdout).toMatch(/^expired: /);
    const stream = await streamOf(a.url, creds.token, requestOf(done));
    expect(stream.events.at(-1)).toMatchObject({ type: 'hopper.expired', phase: 'expired', request: requestOf(done) });
  });

  it('the stream gives a job only its own events; a token that is no job\'s gets nothing', async () => {
    const { a, session } = await start(database());
    await joinBox(a, session, 'hopper-sandbox-web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const asked = await run(a.url, creds.dir, [...ASK, '--wait', '--timeout', '1']);
    const request = requestOf(asked);
    expect(request).not.toBe('');

    const other = credentialsOf(a, (await a.pull({ op: 'echo' })).id);
    expect((await streamOf(a.url, other.token, request)).status).toBe(404);
    expect((await streamOf(a.url, `${creds.token}x`, request)).status).toBe(401);
    expect((await streamOf(a.url, 'not-a-token')).status).toBe(401);
  });
});
