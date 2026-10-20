// Issue #1138: the owner hands approvals to an agent with a **delegate approver**: a grant of the preset
// `delegate-approver`, named, with an end, revocable from Access requests, that approves only what waits for a person — a
// job's vault grant ask, a template, a sandbox request — and declines or denies them. Its **approver policy** names what
// it may never approve (`deny`: e.g. `prod`); that stays the owner's. Each approval it makes records the delegate and the
// person it acts for. The operator CLI acts with it alone, with no database: `HOPPER_REFRESH_TOKEN_FILE` names the file
// that holds the grant's refresh token, and the CLI writes the new one there at each use. Real daemon, real HTTP server,
// real CLI and a real joined box; OpenFGA is a double at its port.
//
// Feature: a delegate approver
//   Scenario: the owner mints a delegate; with only its refresh token, `hopper grant approve <job>` approves a grant ask
//     Given a job on a box of the template kube that asked the vault with no grant
//     When the owner mints a delegate approver cos, with the approver policy deny prod
//     Then it is a box grant of the preset's scopes, with its policy
//     When the agent runs `hopper grant approve <job>` with only the refresh token's file and the hopper's URL
//     Then the job is granted the vault, by "cos (delegate of <the owner>)", with the time
//     And the file holds a new refresh token
//   Scenario: the delegate is refused for settings, secrets and the master key; a delegate mint takes no other scopes
//   Scenario: the approver policy keeps what it names the owner's: a delegate that denies kube is refused the ask
//   Scenario: `hopper grant deny <job>` drops the ask; the job stays refused and asks no more
//   Scenario: a delegate approves only what waits: a job with no ask is refused
//   Scenario: a template approval by the delegate records it; one its policy names is refused
//   Scenario: revoked on Access requests, the delegate is refused at once
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job, TemplateView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { rawRequest } from '../support/http.ts';
import { boxes, helper } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'k3s-token-0123456789abcdef-never-on-disk';
const DELEGATE_BY = /^cos \(delegate of .+\)$/;

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

interface GrantView { key: string; job: string; by: string; at: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any; text: string };

async function boot(): Promise<{ a: TestApp; session: string; dir: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
  });
  const session = await t.login();
  const edit = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await edit({ action: 'set', name: 'KUBE_TOKEN', value: VALUE });
  await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  await edit({ action: 'approve-template', name: 'kube' });
  const dir = await box.join(t, session, 'hopper-sandbox-kube', 'kube');
  return { a: t, session, dir };
}

/** A job on the box that asked the vault for KUBE_TOKEN with no grant: a grant ask. */
async function asking(a: TestApp, dir: string): Promise<Job> {
  const job = await a.waitForStatus((await a.pull({ op: 'sleep', ms: 60000 })).id, 'running', 10000);
  expect((await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, job.id))).stderr).toMatch(/has no vault grant/);
  return job;
}

async function mintDelegate(a: TestApp, session: string, body: Record<string, unknown> = {}): Promise<Answer> {
  const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'cos', preset: 'delegate-approver', days: 30, ...body }, { token: session });
  return { status: r.status, body: r.body, text: JSON.stringify(r.body) };
}

/** The refresh token in a file of its own, as the agent keeps it. */
function refreshFile(refresh: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-delegate-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'refresh');
  writeFileSync(file, `${refresh}\n`, { mode: 0o600 });
  return file;
}

/** The operator CLI with the delegate's refresh token only: no database. */
async function delegateCli(a: TestApp, file: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_REFRESH_TOKEN_FILE: file, HOPPER_URL: a.url }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

/** An API token of the delegate, traded from the refresh token its file holds; the file keeps the new one. */
async function tokenOf(a: TestApp, file: string): Promise<string> {
  const r = await rawRequest(a.url, { method: 'POST', path: '/ui/auth/token/refresh', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: readFileSync(file, 'utf8').trim() }) });
  expect(r.status, r.text).toBe(200);
  const body = JSON.parse(r.text) as { token: string; refresh: string };
  writeFileSync(file, body.refresh);
  return body.token;
}

async function agent(a: TestApp, path: string, token: string, body: unknown): Promise<Answer> {
  const r = await rawRequest(a.url, { method: 'POST', path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: r.text, body: r.text ? JSON.parse(r.text) : undefined };
}

const vault = async (a: TestApp) => (await a.api<{ grantAsks?: { job: string }[]; grants?: GrantView[]; templates: TemplateView[] }>('GET', '/api/vault')).body;

describe('a delegate approver (issue #1138)', () => {
  it('the owner mints a delegate; with only its refresh token, hopper grant approve <job> approves a pending grant ask', async () => {
    const { a, session, dir } = await boot();
    const job = await asking(a, dir);

    const minted = await mintDelegate(a, session, { deny: ['prod'] });
    expect(minted.status, minted.text).toBe(200);
    expect(minted.body.view).toMatchObject({ label: 'cos', box: true, delegate: { deny: ['prod'] } });
    expect(minted.body.view.scopes).toEqual(['jobs:deny-vault', 'jobs:grant-vault', 'sandbox-requests:edit.approve', 'sandbox-requests:edit.approve-run', 'sandbox-requests:edit.decline', 'sandbox-requests:edit.decline-run', 'vault:edit.approve-template', 'vault:read']);
    const file = refreshFile(minted.body.refresh as string);

    const approved = await delegateCli(a, file, ['grant', 'approve', job.id]);
    expect(approved.code, approved.err).toBe(0);
    expect(JSON.parse(approved.out).grants).toEqual([expect.objectContaining({ job: job.id, by: expect.stringMatching(DELEGATE_BY), at: expect.any(String) })]);
    expect(readFileSync(file, 'utf8').trim()).not.toBe(minted.body.refresh);
    expect((await vault(a)).grantAsks).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.granted')).toMatchObject({ jobId: job.id, data: { by: expect.stringMatching(DELEGATE_BY) } });
    expect(await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, job.id))).toMatchObject({ code: 0, stdout: VALUE });

    // It lists what waits, and acts again with the file's new refresh token.
    const list = await delegateCli(a, file, ['grant', 'list']);
    expect(list.code, list.err).toBe(0);
    expect(JSON.parse(list.out)).toEqual([]);
  });

  it('is refused for settings, secrets and the master key; a delegate mint takes no other scope', async () => {
    const { a, session } = await boot();
    const minted = await mintDelegate(a, session);
    const token = await tokenOf(a, refreshFile(minted.body.refresh as string));
    for (const [path, body] of [
      ['/ui/api/vault', { action: 'set', name: 'X', value: 'never-kept-0123456789' }],
      ['/ui/api/vault', { action: 'remove', name: 'KUBE_TOKEN' }],
      ['/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'x' }],
      ['/ui/api/api-tokens/settings', { tokenMinutes: 5 }],
      ['/ui/api/master-key', { action: 'rotate' }],
      ['/ui/api/sandbox-approvals', { yolo: true }],
      ['/ui/api/jobs/x/revoke-vault', {}],
    ] as const) {
      const r = await agent(a, path, token, body);
      expect(r.status, `${path}: ${r.text}`).toBe(403);
    }
    expect((await vault(a)).templates.map((x) => x.name)).toEqual(['kube']);

    const wider = await mintDelegate(a, session, { scopes: ['*'] });
    expect(wider.status).toBe(400);
    expect(wider.text).toMatch(/a delegate approver holds its preset's scopes only/);
    const policyAlone = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'x', scopes: ['*:read'], deny: ['prod'] }, { token: session });
    expect(policyAlone.status).toBe(400);
  });

  it('the approver policy keeps what it names the owner\'s: a delegate that denies kube is refused the ask', async () => {
    const { a, session, dir } = await boot();
    const job = await asking(a, dir);
    const minted = await mintDelegate(a, session, { deny: ['KUBE'] });
    const file = refreshFile(minted.body.refresh as string);
    const refused = await delegateCli(a, file, ['grant', 'approve', job.id]);
    expect(refused).toMatchObject({ code: 2, err: expect.stringMatching(/refused \(403\).*approver policy.*KUBE/) });
    expect((await vault(a)).grants).toEqual([]);
    expect((await vault(a)).grantAsks?.map((x) => x.job)).toEqual([job.id]);
    // The owner still approves it.
    expect((await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token: session })).status).toBe(200);
  });

  it('hopper grant deny <job> drops the ask: the job stays refused and asks no more; a job with no ask is refused', async () => {
    const { a, session, dir } = await boot();
    const job = await asking(a, dir);
    const file = refreshFile((await mintDelegate(a, session)).body.refresh as string);

    const denied = await delegateCli(a, file, ['grant', 'deny', job.id]);
    expect(denied.code, denied.err).toBe(0);
    expect(JSON.parse(denied.out).grantAsks).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.grant_denied')).toMatchObject({ jobId: job.id, data: { job: job.id, by: expect.stringMatching(DELEGATE_BY) } });
    expect((await helper(dir, ['get', 'KUBE_TOKEN'], box.tokenFileOf(a, job.id))).stderr).toMatch(/has no vault grant/);
    expect((await vault(a)).grantAsks).toEqual([]);

    // Nothing waits for this job now: a delegate approves only what waits.
    expect(await delegateCli(a, file, ['grant', 'approve', job.id])).toMatchObject({ code: 2, err: expect.stringMatching(/refused \(409\).*no grant ask waits/) });
    expect((await vault(a)).grants).toEqual([]);
  });

  it('a template approval by the delegate records it; one its policy names is refused', async () => {
    const { a, session } = await boot();
    const edit = (body: Record<string, unknown>) => a.ui('/ui/api/vault', body, { token: session });
    await edit({ action: 'save-template', name: 'lab', image: 'localhost/box-kubectl:2', secrets: ['KUBE_TOKEN'] });
    await edit({ action: 'save-template', name: 'shop', image: 'localhost/box-kubectl:2', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'shop-prod' } }] });
    const file = refreshFile((await mintDelegate(a, session, { deny: ['prod'] })).body.refresh as string);

    const approved = await delegateCli(a, file, ['template', 'approve', 'lab']);
    expect(approved.code, approved.err).toBe(0);
    expect((await a.events()).find((e) => e.type === 'vault.approved' && (e.data as { template?: string }).template === 'lab')).toMatchObject({ data: { by: expect.stringMatching(DELEGATE_BY) } });
    expect(await delegateCli(a, file, ['template', 'approve', 'shop'])).toMatchObject({ code: 2, err: expect.stringMatching(/refused \(403\).*approver policy.*prod/) });
    expect((await vault(a)).templates.find((x) => x.name === 'shop')?.pending.image).toBe(true);
  });

  it('revoked on Access requests, the delegate is refused at once', async () => {
    const { a, session, dir } = await boot();
    const job = await asking(a, dir);
    const minted = await mintDelegate(a, session);
    const file = refreshFile(minted.body.refresh as string);
    expect((await a.ui('/ui/api/api-tokens', { action: 'revoke', id: minted.body.grant }, { token: session })).status).toBe(200);
    expect(await delegateCli(a, file, ['grant', 'approve', job.id])).toMatchObject({ code: 2, err: expect.stringMatching(/refused \(401\)/) });
    expect((await vault(a)).grants).toEqual([]);
  });

  it('refuses --user with a refresh token, and no hopper URL', async () => {
    const { a, session } = await boot();
    const file = refreshFile((await mintDelegate(a, session)).body.refresh as string);
    expect(await delegateCli(a, file, ['grant', 'list', '--user', 'x'])).toMatchObject({ code: 2, err: expect.stringContaining('--user') });
  });
});
