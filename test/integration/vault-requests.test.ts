// Issue #583, through the real composition root, the real HTTP server and a real joined client: the dynamic vault. A
// job on a box loads a skill (Render) whose credential its template does not give; the hopper asks a person; the person
// gives one, of the kind the hopper suggested or another, or declines; the job then gets it just in time through the
// vault's helper, and the value never shows again (design.md "The dynamic vault"). The job runs the real `hopper-skill`
// (issue #582) and the real `hopper-secret` (issue #558). OpenFGA is a double at the AuthorizationServer seam.
//
// Feature: the vault asks for the credentials new work needs
//   Scenario: a job that needs Render, with no Render credential in the vault, makes the hopper ask the user for one
//     Given the template web, approved, with nothing in its scope, a box joined as web, and a job running on it
//     When the job runs `sh "$HOPPER_SKILL" render --why "deploy the web service"`
//     Then it is told the user is asked (202), and the vault shows a credential request: render, for web, the job and
//       why, a Render API key suggested, how to get one
//     When the job waits (`--wait`) and an admin gives a Render API key for the request
//     Then the wait ends with the skill and how to use the vault secret render, never its value
//     And the job gets the value just in time with `$HOPPER_SECRET get render`; no answer, event, log or file holds it
//   Scenario: the user gives another kind of credential than the one suggested; the job is told what it is
//   Scenario: the user declines: the job is told why
//   Scenario: a service the hopper has no skill for is asked in the job's own words; without them, a no with the skills
//   Scenario: a template never approved still waits for a person after the credential is given
//   Scenario: a machine of no template: the hopper asks nobody
//   Scenario: a Kubernetes link Access allows, with no token in the template: the user is asked, with how to make one
import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { HELPER_FILE } from '../../src/client/vault.ts';
import type { CredentialRequest, VaultView } from '../../src/domain/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const VALUE = 'rnd_render-api-key-0123456789-never-shown';

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

type Edit = (body: Record<string, unknown>) => Promise<{ status: number; body: VaultView }>;

/** A hopper with the template web — approved unless said — whose scope is empty: no Render credential anywhere. */
async function boot(approved = true): Promise<{ a: TestApp; session: string; edit: Edit }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const session = await t.login();
  const a = t;
  const edit: Edit = async (body) => {
    const r = await a.ui<VaultView>('/ui/api/vault', body, { token: session });
    return { status: r.status, body: r.body };
  };
  await edit({ action: 'save-template', name: 'web', image: 'localhost/box-render:1', secrets: [] });
  if (approved) await edit({ action: 'approve-template', name: 'web' });
  return { a, session, edit };
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

async function runningJob(a: TestApp, machine: string): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe(`${machine}/lane-1`);
  return job.id;
}

/** The job's credentials dir, as the hopper keeps it: its proxy token and `hopper-skill`. */
function credentialsOf(a: TestApp, job: string): string {
  const dir = temp('job-credentials-');
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return dir;
}

type Run = { code: number; stdout: string; stderr: string };
const env = (a: TestApp, creds: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token'), HOPPER_SKILL_POLL: '0.1' });

function run(file: string, args: string[], e: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile(file, args, { env: e, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

/** `hopper-skill`, as the job runs it. */
const skill = (a: TestApp, creds: string, args: string[]): Promise<Run> => run('sh', [join(creds, 'skill'), ...args], env(a, creds));
/** `hopper-secret` on the box, as the job runs it. */
const secret = (a: TestApp, box: string, creds: string, args: string[]): Promise<Run> => run(join(box, HELPER_FILE), args, env(a, creds));

/** `hopper-skill … --wait` in the background, as the job is told to run it: its end, when it comes. */
function waiting(a: TestApp, creds: string, args: string[]): Promise<Run> {
  const child = spawn('sh', [join(creds, 'skill'), ...args, '--wait'], { env: env(a, creds) });
  cleanups.push(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr })));
}

async function requestFor(a: TestApp, skillName: string): Promise<CredentialRequest> {
  return waitFor(async () => ((await a.api('GET', '/api/vault')).body as VaultView).requests?.find((r) => r.skill === skillName), { timeoutMs: 10000, what: `a ${skillName} request` });
}

function nowhere(a: TestApp, box: string, value: string): void {
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
  for (const f of readdirSync(box)) if (f !== 'vault.sock') expect(readFileSync(join(box, f), 'utf8')).not.toContain(value);
}

describe('the vault asks for the credentials new work needs (issue #583)', () => {
  it('a job that needs Render, with no Render credential, makes the hopper ask the user; once given, the job gets it just in time, the value never shown', async () => {
    const { a, session, edit } = await boot();
    const box = await joinMachine(a, session, 'hopper-sandbox-web', 'web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);

    expect((await skill(a, creds, [])).stdout).toMatch(/^render: deploy and look at services on Render/m);
    const asked = await skill(a, creds, ['render', '--why', 'deploy the web service']);
    expect(asked.code).toBe(3);
    expect(asked.stdout).toMatch(/^waiting: the hopper asked the user for A Render API key for render \(they may give another kind\)\. Run the same command again/);
    const r = await requestFor(a, 'render');
    expect(r).toMatchObject({ known: true, template: 'web', secret: 'render', asked: [{ job, machine: 'hopper-sandbox-web', why: 'deploy the web service' }] });
    expect(r.kinds.map((k) => k.id)).toEqual(['api-key', 'deploy-hook']);
    expect(r.setup).toMatch(/Account Settings → API Keys/);
    expect((await a.events()).filter((e) => e.type === 'vault.credential_asked')).toEqual([
      expect.objectContaining({ jobId: job, data: { request: r.id, skill: 'render', template: 'web', machine: 'hopper-sandbox-web', job, why: 'deploy the web service' } }),
    ]);

    const wait = waiting(a, creds, ['render']);
    await new Promise((done) => setTimeout(done, 300));
    const given = await edit({ action: 'give-credential', request: r.id, name: 'render', kind: 'api-key', value: VALUE });
    expect(given.status).toBe(200);
    expect(JSON.stringify(given.body)).not.toContain(VALUE);
    expect(given.body.requests).toEqual([]);
    expect(given.body.templates.find((x) => x.name === 'web')).toMatchObject({ secrets: ['render'], gives: ['render'] });
    expect(given.body.secrets.find((s) => s.name === 'render')).toMatchObject({ skill: 'render', kind: 'api-key' });

    const done = await wait;
    expect(done.code).toBe(0);
    expect(done.stdout).toMatch(/^render: deploy and look at services on Render/);
    expect(done.stdout).toContain('Vault secret: render — A Render API key.');
    expect(done.stdout).toContain('RENDER_API_KEY="$("$HOPPER_SECRET" get render)"');
    expect(done.stderr).toMatch(/^waiting: the hopper asked the user/);
    expect(done.stdout + done.stderr).not.toContain(VALUE);

    expect(await secret(a, box, creds, ['get', 'render'])).toMatchObject({ code: 0, stdout: VALUE });
    expect((await a.events()).find((e) => e.type === 'vault.credential_given')).toMatchObject({ data: { request: r.id, skill: 'render', name: 'render', kind: 'api-key', template: 'web', approved: true, jobs: [job] } });
    expect((await a.events()).find((e) => e.type === 'skill.loaded')).toMatchObject({ jobId: job, data: { skill: 'render', template: 'web' } });
    expect(JSON.stringify((await a.api('GET', '/api/vault')).body)).not.toContain(VALUE);
    nowhere(a, box, VALUE);
  });

  it('the user gives another kind than the one suggested; the job is told what it is, in the user\'s words', async () => {
    const { a, session, edit } = await boot();
    const box = await joinMachine(a, session, 'hopper-sandbox-web', 'web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    await skill(a, creds, ['render']);
    const r = await requestFor(a, 'render');

    expect((await edit({ action: 'give-credential', request: r.id, name: 'render-team', kind: 'other', value: VALUE })).status).toBe(400);
    expect((await edit({ action: 'give-credential', request: r.id, name: 'render-team', kind: 'sso', value: VALUE })).status).toBe(400);
    expect((await edit({ action: 'give-credential', request: r.id, name: 'render-team', kind: 'other', note: 'a team API key, read-only, for the staging team', value: VALUE })).status).toBe(200);

    const ready = await skill(a, creds, ['render']);
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain('Vault secret: render-team — something the user described (the user says: a team API key, read-only, for the staging team).');
    expect(ready.stdout).toContain('"$HOPPER_SECRET" get render-team');
    expect(await secret(a, box, creds, ['get', 'render-team'])).toMatchObject({ code: 0, stdout: VALUE });
  });

  it('the user declines: the job that waits is told why, and gets nothing', async () => {
    const { a, session, edit } = await boot();
    await joinMachine(a, session, 'hopper-sandbox-web', 'web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const wait = waiting(a, creds, ['render']);
    const r = await requestFor(a, 'render');
    expect((await edit({ action: 'decline-credential', request: r.id, reason: 'deploy by hand this time' })).body.requests).toEqual([]);
    const done = await wait;
    expect(done.code).toBe(1);
    expect(done.stdout).toMatch(/^no: the user declined to give a render credential: deploy by hand this time\./);
    expect((await a.events()).find((e) => e.type === 'vault.credential_declined')).toMatchObject({ data: { skill: 'render', reason: 'deploy by hand this time', jobs: [job] } });
  });

  it('a service the hopper has no skill for: asked in the job\'s own words it is a request too', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'hopper-sandbox-web', 'web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const asked = await skill(a, creds, ['flyio', '--credential', 'a Fly.io deploy token', '--why', 'deploy the API']);
    expect(asked.code).toBe(3);
    expect(asked.stdout).toMatch(/^waiting: the hopper asked the user for a Fly\.io deploy token for flyio/);
    expect(await requestFor(a, 'flyio')).toMatchObject({ known: false, kinds: [{ id: 'asked', title: 'a Fly.io deploy token' }], asked: [{ why: 'deploy the API' }] });
  });

  it('a template never approved: the credential given still waits for a person; approved, the job gets it', async () => {
    const { a, session, edit } = await boot(false);
    await joinMachine(a, session, 'hopper-sandbox-web', 'web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    expect((await skill(a, creds, ['render'])).code).toBe(3);
    const r = await requestFor(a, 'render');
    const given = await edit({ action: 'give-credential', request: r.id, name: 'render', kind: 'deploy-hook', value: 'https://api.render.com/deploy/srv-x?key=never-shown' });
    expect(given.body.templates.find((x) => x.name === 'web')).toMatchObject({ secrets: ['render'], gives: [] });
    expect(await skill(a, creds, ['render'])).toMatchObject({ code: 3, stdout: expect.stringMatching(/template web waits for a person's approval/) });
    await edit({ action: 'approve-template', name: 'web' });
    const ready = await skill(a, creds, ['render']);
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain('A deploy hook URL of one service');
    expect(ready.stdout).not.toContain('never-shown');
  });

  it('a machine of no template: the hopper asks nobody', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'laptop');
    const job = await runningJob(a, 'laptop');
    const r = await skill(a, credentialsOf(a, job), ['render']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^no: laptop is no box of a template/);
    expect(((await a.api('GET', '/api/vault')).body as VaultView).requests).toEqual([]);
  });

  it('a Kubernetes link Access allows, with no token in the template: the user is asked, with how to make one; given, the link names it', async () => {
    const { a, session, edit } = await boot();
    await a.ui('/ui/api/access', { action: 'approve', template: 'web', operation: 'read', asset: { kind: 'cluster', name: 'prod' } }, { token: session });
    await joinMachine(a, session, 'hopper-sandbox-web', 'web');
    const job = await runningJob(a, 'hopper-sandbox-web');
    const creds = credentialsOf(a, job);
    const asked = await skill(a, creds, ['kube-diagnostics', 'cluster/prod']);
    expect(asked.code).toBe(3);
    const r = await requestFor(a, 'kube-diagnostics');
    expect(r.setup).toMatch(/kubectl create token/);
    expect((await edit({ action: 'give-credential', request: r.id, name: 'prod-view', kind: 'token', value: VALUE })).status).toBe(200);
    const ready = await skill(a, creds, ['kube-diagnostics', 'cluster/prod']);
    expect(ready.code).toBe(0);
    expect(ready.stdout).toMatch(/args: \[kube, prod-view\]/);
    expect(ready.stdout).not.toContain(VALUE);
  });
});
