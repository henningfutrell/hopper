// Issue #558, slice 3, through the real composition root, the real HTTP server and a real joined client: a box gets a
// vault secret just in time. The job runs the client's helper (HOPPER_SECRET), showing its proxy token (issue #563);
// the client asks the hopper over a request signed with its link; the hopper gives a secret only in the approved scope
// of the box's template, only to a job at work on that box, sealed to that one request. Nothing is in the job's
// environment or on the box's disk (design.md "The vault").
//
// Feature: a secret delivered to the box, just in time
//   Scenario: a box whose template is not approved is refused (its approval revoked while a job runs there: a box of a
//     template not approved takes no new job, issue #602)
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
//   Scenario: with the vault in a container of its own (issue #586), the approved box's job gets the value just the same
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLink } from '../../src/client/join.ts';
import { MACHINE_KEY_HEADER, USER_HEADER, linkToken, mintLinkKey } from '../../src/client/link.ts';
import { REQUEST_HEADER, signVault } from '../../src/client/signature.ts';
import { VAULT_CONTENT_TYPE, VAULT_PATH } from '../../src/client/vault.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'k3s-token-0123456789abcdef-never-on-disk';
const PROD = 'prod-key-fedcba9876543210-never-on-disk';

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
const stops: (() => Promise<void>)[] = [];
const saved = { ...process.env };
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const s of stops.splice(0)) await s();
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
  vi.restoreAllMocks();
});

/** `container`: the vault in a container of its own (issue #586), holding the master key; the hopper holds none. */
async function boot(o: { container?: boolean } = {}): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const vault = o.container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
  if (vault) stops.push(() => vault.stop());
  const keys = vault ? { secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_VAULT_KEY: VAULT_KEY }, env: { HOPPER_VAULT_URL: vault.url } } : { secrets: { HOPPER_MASTER_KEY: KEY } };
  t = await startTestApp({ dbPath: db.dbPath, ...keys, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } } });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'KUBE_TOKEN', value: VALUE });
  await edit({ action: 'set', name: 'PROD_KEY', value: PROD });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  return { a: t, session };
}

const joinMachine = box.join;
const tokenFileOf = box.tokenFileOf;

/** Nothing the hopper logged or appended carries `value`, and nothing on the machine's client dir does. */
function nowhere(a: TestApp, dir: string, value: string): void {
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
  for (const f of readdirSync(dir)) if (f !== 'vault.sock') expect(readFileSync(join(dir, f), 'utf8')).not.toContain(value);
}

describe('a secret delivered to the box, just in time', () => {
  it('a box whose template is not approved is refused; approved again, its job gets the value, recorded without it', async () => {
    const { a, session } = await boot();
    // A box of a template not approved takes no job (issue #602): the job starts on an approved box, then the approval is revoked.
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const dir = await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const token = tokenFileOf(a, job);
    await a.ui('/ui/api/vault', { action: 'revoke-template', name: 'kube' }, { token: session });

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

describe('a secret delivered to the box, with the vault in a container of its own (issue #586)', () => {
  it('the approved box\'s job gets the value; the refusal and the delivery are in the hopper\'s event log, without it', async () => {
    const { a, session } = await boot({ container: true });
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    const dir = await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await runningJob(a, 'hopper-sandbox-kube');
    const token = tokenFileOf(a, job);
    await a.ui('/ui/api/vault', { action: 'revoke-template', name: 'kube' }, { token: session });

    const refused = await helper(dir, ['get', 'KUBE_TOKEN'], token);
    expect(refused.stderr).toMatch(/kube is not approved for KUBE_TOKEN/);
    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], token)).toMatchObject({ code: 0, stdout: VALUE });
    expect(await helper(dir, ['get', 'PROD_KEY'], token)).toMatchObject({ stdout: '', stderr: expect.stringMatching(/kube is not approved for PROD_KEY/) });

    const events = await a.events();
    expect(events.find((e) => e.type === 'vault.delivered')).toMatchObject({ jobId: job, machineId: 'hopper-sandbox-kube', data: { name: 'KUBE_TOKEN', template: 'kube', job } });
    expect(events.filter((e) => e.type === 'vault.refused')).toHaveLength(2);
    nowhere(a, dir, VALUE);
    nowhere(a, dir, PROD);
  });
});
