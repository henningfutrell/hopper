// Issue #2356, through the real composition root, the real HTTP server and a real joined client: a job that runs on a
// machine of no template asks for a credential its sandbox runs' template does not give. Before, the hopper refused it
// (only a box of a template could ask), and a template could not name a vault secret that did not exist yet: a new
// secret had no way in from a job. Now the job names the template of its approved sandbox runs (`--template NAME`): the
// hopper opens the credential request for that template, a person gives the credential, and the template's box steps
// get it. The value never shows (design.md "The dynamic vault").
//
// Feature: a job off a box asks for a credential for the template of its sandbox runs
//   Scenario: the template's sandbox runs are not approved for the job: the hopper asks nobody, and says how to ask
//   Scenario: they are approved: the request opens on Asked for, for the template, from the job's machine
//     When a person gives the credential
//     Then the template gives it, the job is told to read it in a box step of the template, never the value
//   Scenario: a template request names a vault secret that does not exist yet: the no says how to ask for it
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { CredentialRequest, VaultView } from '../../src/domain/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';
import { grantVault } from '../support/vault-box.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const VALUE = 'example-api-token-0123456789-never-shown';
const SERVICE = 'example-api';
const ASK = ['--template', 'web', '--credential', 'an API token', '--why', 'deploy the web service'];

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

type Run = { code: number; stdout: string; stderr: string };
interface Booted { a: TestApp; session: string; job: string; creds: string; edit(body: Record<string, unknown>): Promise<{ status: number; body: VaultView }> }

/** A hopper with the template web, approved and with nothing in its scope, and a job running on a machine of no template. */
async function boot(): Promise<Booted> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const a = t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const session = await a.login();
  const edit = async (body: Record<string, unknown>): Promise<{ status: number; body: VaultView }> => {
    const r = await a.ui<VaultView>('/ui/api/vault', body, { token: session });
    return { status: r.status, body: r.body };
  };
  await edit({ action: 'save-template', name: 'web', image: 'localhost/box-web:1', secrets: [] });
  await edit({ action: 'approve-template', name: 'web' });
  const dir = temp('hopper-machine-');
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name: 'laptop', dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'laptop' && m.online), { timeoutMs: 10000, what: 'laptop online' });
  const job = (await a.pull({ op: 'sleep', ms: 60000 })).id;
  expect((await a.waitForStatus(job, 'running', 10000)).laneId).toBe('laptop/lane-1');
  await grantVault(a, job);
  const creds = temp('job-credentials-');
  writeFileSync(join(creds, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
  writeFileSync(join(creds, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return { a, session, job, creds, edit };
}

/** `hopper-skill`, as the job runs it. */
function skill(b: Booted, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(b.creds, 'skill'), ...args], { env: { PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(b.creds, 'token') }, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

const requests = async (b: Booted): Promise<CredentialRequest[]> => ((await b.a.api('GET', '/api/vault')).body as VaultView).requests ?? [];

/** The job asks for the sandbox runs of web, and a person approves them when they wait for one. */
async function approvedRuns(b: Booted): Promise<void> {
  if ((await skill(b, ['sandbox', '--template', 'web', '--why', 'deploy the web service'])).code === 3) {
    const approved = await b.a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve-run', job: b.job, template: 'web' }, { token: b.session });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  }
  expect(await skill(b, ['sandbox', '--template', 'web', '--why', 'deploy the web service'])).toMatchObject({ code: 0, stdout: expect.stringContaining('approved for this job') });
}

describe('a job off a box asks for a credential for the template of its sandbox runs (issue #2356)', () => {
  it('with no approved sandbox runs of the template, the hopper asks nobody and says how to ask for them', async () => {
    const b = await boot();
    const r = await skill(b, [SERVICE, ...ASK]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^no: this job has no approved sandbox runs of template web\. .*sh "\$HOPPER_SKILL" sandbox --template web/);
    expect(await requests(b)).toEqual([]);
  });

  it('with approved sandbox runs, the request opens for the template; once given, the template gives it and the job reads it in a box step, the value never shown', async () => {
    const b = await boot();
    await approvedRuns(b);
    const asked = await skill(b, [SERVICE, ...ASK]);
    expect(asked.code, asked.stdout).toBe(3);
    expect(asked.stdout).toMatch(/^waiting: the hopper asked the user for an API token for example-api/);
    const [r] = await requests(b);
    expect(r).toMatchObject({ skill: SERVICE, template: 'web', asked: [{ job: b.job, machine: 'laptop', why: 'deploy the web service' }] });
    expect((await b.a.events()).filter((e) => e.type === 'vault.credential_asked')).toEqual([
      expect.objectContaining({ jobId: b.job, data: { request: r!.id, skill: SERVICE, template: 'web', machine: 'laptop', job: b.job, why: 'deploy the web service' } }),
    ]);

    const given = await b.edit({ action: 'give-credential', request: r!.id, name: SERVICE, kind: 'asked', value: VALUE });
    expect(given.status).toBe(200);
    expect(given.body.templates.find((x) => x.name === 'web')).toMatchObject({ secrets: [SERVICE], gives: [SERVICE] });

    const ready = await skill(b, [SERVICE, ...ASK]);
    expect(ready.code, ready.stdout).toBe(0);
    expect(ready.stdout).toContain('Vault secret: example-api — an API token.');
    expect(ready.stdout).toContain('sh "$HOPPER_STEP" box web --command');
    expect((await b.a.events()).find((e) => e.type === 'skill.loaded' && e.data.skill === SERVICE)).toMatchObject({ jobId: b.job, data: { template: 'web', machine: 'laptop' } });
    expect(JSON.stringify(b.a.user().store.events.since(0, 100_000))).not.toContain(VALUE);
    expect(JSON.stringify((await b.a.api('GET', '/api/vault')).body)).not.toContain(VALUE);
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  it('a template request that names a vault secret that does not exist yet: the no says how to ask for it', async () => {
    const b = await boot();
    const r = await skill(b, ['sandbox-template', '--why', 'deploy the web service', '--secrets', 'deploy-key', '--egress', 'api.example.com:443']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^no: the vault holds no secret deploy-key\. .*without --secrets.*SERVICE --template NAME --credential/);
  });
});
