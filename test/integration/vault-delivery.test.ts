// Issue #558, slice 3, through the real composition root, the real HTTP server and a real joined client: a box gets a
// vault secret just in time. The job runs the client's helper (HOPPER_SECRET), showing its proxy token (issue #563);
// the client asks the hopper over a request signed with its link; the hopper gives a secret only in the approved scope
// of the box's template, only to a job at work on that box, sealed to that one request. Nothing is in the job's
// environment or on the box's disk (design.md "The vault").
//
// Feature: a secret delivered to the box, just in time
//   Scenario: a box of a template nobody approved is refused
//     Given the vault secret KUBE_TOKEN, the template kube with KUBE_TOKEN in its scope, a box joined as kube
//     And a job running on the box
//     When the job runs `$HOPPER_SECRET get KUBE_TOKEN`
//     Then it is refused: the template is not approved
//   Scenario: once the template is approved, the job gets the value, as kubectl's exec plugin wants it too
//     Then the vault records it was delivered: the template, the machine, the job, the secret — never the value
//   Scenario: a secret outside the template's scope is refused
//   Scenario: a job that ended, or a token the hopper did not derive, gets nothing
//   Scenario: a computer of no template gets nothing
//   Scenario: an ask not signed by the machine's link is refused
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinHopper, readLink } from '../../src/client/join.ts';
import { MACHINE_KEY_HEADER, USER_HEADER, linkToken, mintLinkKey } from '../../src/client/link.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { REQUEST_HEADER, signVault } from '../../src/client/signature.ts';
import { HELPER_FILE, VAULT_CONTENT_TYPE, VAULT_PATH } from '../../src/client/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const VALUE = 'k3s-token-0123456789abcdef-never-on-disk';
const PROD = 'prod-key-fedcba9876543210-never-on-disk';

let t: TestApp | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY }, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } } });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'KUBE_TOKEN', value: VALUE });
  await edit({ action: 'set', name: 'PROD_KEY', value: PROD });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  return { a: t, session };
}

/** A machine joined — as a box of `template`, when given — and its client started: its client dir. */
async function joinMachine(a: TestApp, session: string, name: string, template?: string): Promise<string> {
  const dir = temp('hopper-machine-');
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', template ? { template } : {}, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
  return dir;
}

/** A job that runs a while, on the one machine there is. */
async function runningJob(a: TestApp, machine: string): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe(`${machine}/lane-1`);
  return job.id;
}

/** The job's proxy token as the hopper derives it (issue #563), in a file of the job's. */
function tokenFileOf(a: TestApp, job: string, token?: string): string {
  const file = join(temp('job-credentials-'), 'token');
  writeFileSync(file, `${token ?? proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
  return file;
}

/** The helper, run as a job runs it: its token file, and nothing of the vault in its environment. */
function helper(dir: string, args: string[], tokenFile: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(join(dir, HELPER_FILE), args, { env: { PATH: process.env.PATH, HOPPER_TOKEN_FILE: tokenFile, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** Nothing the hopper logged or appended carries `value`, and nothing on the machine's client dir does. */
function nowhere(a: TestApp, dir: string, value: string): void {
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
  for (const f of readdirSync(dir)) if (f !== 'vault.sock') expect(readFileSync(join(dir, f), 'utf8')).not.toContain(value);
}

describe('a secret delivered to the box, just in time', () => {
  it('a box of a template nobody approved is refused; once approved, its job gets the value, recorded without it', async () => {
    const { a, session } = await boot();
    const dir = await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const token = tokenFileOf(a, job);

    const refused = await helper(dir, ['get', 'KUBE_TOKEN'], token);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/kube is not approved for KUBE_TOKEN/);
    expect(refused.stdout).toBe('');

    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: VALUE });
    const kube = await helper(dir, ['kube', 'KUBE_TOKEN'], token);
    expect(JSON.parse(kube.stdout)).toEqual({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: VALUE } });

    const delivered = (await a.events()).filter((e) => e.type === 'vault.delivered');
    expect(delivered[0]).toMatchObject({ jobId: job, machineId: 'hopper-sandbox-kube', data: { name: 'KUBE_TOKEN', template: 'kube', machine: 'hopper-sandbox-kube', job } });
    expect((await a.events()).find((e) => e.type === 'vault.refused')).toMatchObject({ data: { name: 'KUBE_TOKEN', template: 'kube', reason: expect.stringMatching(/not approved/) } });
    expect(((await a.api('GET', '/api/vault')).body.secrets as { name: string; lastUsed?: unknown }[]).find((s) => s.name === 'KUBE_TOKEN')!.lastUsed)
      .toMatchObject({ machine: 'hopper-sandbox-kube', job, at: expect.any(String) });
    nowhere(a, dir, VALUE);
  });

  it('a secret outside the template\'s scope is refused, approved or not', async () => {
    const { a, session } = await boot();
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const dir = await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const r = await helper(dir, ['get', 'PROD_KEY'], tokenFileOf(a, job));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/kube is not approved for PROD_KEY/);
    expect(r.stdout).toBe('');
    nowhere(a, dir, PROD);
  });

  it('a job that ended, or a token the hopper did not derive, gets nothing', async () => {
    const { a, session } = await boot();
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const dir = await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const done = await a.pull({ op: 'echo' });
    await a.waitForStatus(done.id, 'finished');
    const ended = await helper(dir, ['get', 'KUBE_TOKEN'], tokenFileOf(a, done.id));
    expect(ended.code).not.toBe(0);
    expect(ended.stderr).toMatch(/not at work/);
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const forged = proxyToken(mintLinkKey().privateKey, a.user().user.id, job);
    const r = await helper(dir, ['get', 'KUBE_TOKEN'], tokenFileOf(a, job, forged));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a token the hopper gave/);
    expect(r.stdout).toBe('');
  });

  it('a computer of no template gets nothing', async () => {
    const { a, session } = await boot();
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const dir = await joinMachine(a, session, 'laptop');
    const job = await runningJob(a, 'laptop');
    const r = await helper(dir, ['get', 'KUBE_TOKEN'], tokenFileOf(a, job));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/laptop is no box of a template/);
  });

  it('an ask not signed by the machine\'s link is refused, and gives nothing', async () => {
    const { a, session } = await boot();
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const dir = await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const link = readLink(dir);
    const body = JSON.stringify({ name: 'KUBE_TOKEN', token: proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job) });
    const forged = linkToken(mintLinkKey().privateKey, link.hopperKey);
    const res = await fetch(new URL(VAULT_PATH, a.url), {
      method: 'POST',
      headers: { 'content-type': VAULT_CONTENT_TYPE, [USER_HEADER]: link.user, [MACHINE_KEY_HEADER]: link.key, [REQUEST_HEADER]: signVault(forged, link.user, link.key, body) },
      body,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(VALUE);
  });
});
