// Issue #718, item 3: shared secrets, through the real composition root, the real HTTP server, a real joined box and
// the real operator CLI; OpenFGA is the double that evaluates the default model. A vault secret is the user's by
// default. The hopper's admin may instead share one: kept in the instance's vault as `shared/<name>`, sealed under the
// master key, listed for every user (never its value), and given to a job on a box only when the box's template names
// it, a person approved that, and Access (`shared_secret#can_read`) allows the job's user.
//
// Feature: shared secrets
//   Scenario: the hopper's admin shares a secret; every user lists it, never its value; another admin may not share one
//     Given a hopper with a master key and a second user, Bea
//     When the hopper's admin shares AWS_DIAG
//     Then GET /api/vault lists shared/AWS_DIAG for both users, with no value, and the instance's vault holds it sealed
//     And Bea, an admin of her own user only, is refused when she shares one
//   Scenario: a job on a box of an approved template that names it gets the value
//     Given the template kube names shared/AWS_DIAG
//     When the template is widened to it, its job is refused until a person approves it
//     Then the job gets the value, and the delivery is recorded without it
//   Scenario: a template may not name a shared secret the hopper does not hold
//   Scenario: readers named leave the job's user out: Access refuses it; removed, nothing is given
//   Scenario: the operator CLI shares a secret from stdin, lists it, and removes it
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { VaultView } from '../../src/domain/vault.ts';
import { openDb } from '../../src/store/db.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';
import { KEY } from '../support/webhooks.ts';

const VALUE = 'aws-diag-0123456789abcdef-shared-never-read-back';
const KUBE = 'kube-token-0123456789abcdef-never-on-disk';

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
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
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { authorizationServer: createFakeAuthorizationServer() },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
  });
  const session = await t.login();
  await t.ui('/ui/api/vault', { action: 'set', name: 'KUBE_TOKEN', value: KUBE }, { token: session });
  return { a: t, session };
}

const share = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<VaultView & { error?: string }>('/ui/api/vault/shared', body, { token: session });
const vaultOf = async (a: TestApp, session?: string): Promise<VaultView> =>
  (await a.api<VaultView>('GET', '/api/vault', undefined, session ? { 'x-hopper-session': session } : {})).body;

/** Nothing the hopper logged or appended carries `value`, and nothing on the machine's client dir does. */
function nowhere(a: TestApp, value: string, dir?: string): void {
  expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(value);
  expect(logged.join('\n')).not.toContain(value);
  if (dir) for (const f of readdirSync(dir)) if (f !== 'vault.sock') expect(readFileSync(join(dir, f), 'utf8')).not.toContain(value);
}

/** The box of the template kube, approved with `secrets`, a job at work on it, and its token file. */
async function kubeBox(a: TestApp, session: string, secrets: string[]): Promise<{ dir: string; job: string; token: string }> {
  expect((await a.ui('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets }, { token: session })).status).toBe(200);
  await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
  const dir = await box.join(a, session, 'hopper-sandbox-kube', 'kube');
  const job = await runningJob(a, 'hopper-sandbox-kube');
  return { dir, job, token: box.tokenFileOf(a, job) };
}

describe('shared secrets (issue #718)', () => {
  it('the hopper\'s admin shares a secret; every user lists it, never its value; another admin may not share one', async () => {
    const { a, session } = await boot();
    const r = await share(a, session, { action: 'set', name: 'AWS_DIAG', value: VALUE, scope: 'read-only diagnostics' });
    expect(r.status).toBe(200);
    expect(r.body.shared).toEqual([expect.objectContaining({ name: 'shared/AWS_DIAG', scope: 'read-only diagnostics', setBy: expect.any(String) })]);
    expect(r.body.shared![0]!.readers).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(VALUE);
    // Not one of the user's own secrets.
    expect(r.body.secrets.map((s) => s.name)).toEqual(['KUBE_TOKEN']);

    const bea = await a.addUser('Bea');
    const beaSession = await a.login(bea.id);
    expect((await vaultOf(a, beaSession)).shared?.map((s) => s.name)).toEqual(['shared/AWS_DIAG']);
    const refused = await share(a, beaSession, { action: 'set', name: 'BEA_KEY', value: 'bea-0123456789' });
    expect(refused.status).toBe(403);
    expect((await vaultOf(a, session)).shared?.map((s) => s.name)).toEqual(['shared/AWS_DIAG']);

    // Sealed in the instance's vault, under the master key; the event names it, never its value.
    const db = openDb(databaseUrlFor(a.dbPath));
    try {
      const rows = db.all('SELECT name, sealed FROM vault_secrets WHERE name LIKE \'shared/%\'');
      expect(rows.map((x) => x.name)).toEqual(['shared/AWS_DIAG']);
      expect(String(rows[0]!.sealed)).not.toContain(VALUE);
    } finally { db.close(); }
    expect((await a.events()).find((e) => e.type === 'vault.secret_set' && (e.data as { name: string }).name === 'shared/AWS_DIAG')).toBeDefined();
    nowhere(a, VALUE);
  });

  it('a job on a box of an approved template that names it gets the value', async () => {
    const { a, session } = await boot();
    await share(a, session, { action: 'set', name: 'AWS_DIAG', value: VALUE });
    const { dir, job, token } = await kubeBox(a, session, ['KUBE_TOKEN']);

    // Widened to the shared secret: it waits for a person, and the job is refused meanwhile.
    await a.ui('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN', 'shared/AWS_DIAG'] }, { token: session });
    const kube = (await vaultOf(a)).templates.find((x) => x.name === 'kube')!;
    expect(kube.pending.secrets).toEqual(['shared/AWS_DIAG']);
    const waiting = await helper(dir, ['get', 'shared/AWS_DIAG'], token);
    expect(waiting.code).not.toBe(0);
    expect(waiting.stderr).toMatch(/kube is not approved for shared\/AWS_DIAG/);

    await a.ui('/ui/api/vault', { action: 'approve-template', name: 'kube' }, { token: session });
    expect(await helper(dir, ['get', 'shared/AWS_DIAG'], token)).toMatchObject({ code: 0, stdout: VALUE });
    const delivered = (await a.events()).filter((e) => e.type === 'vault.delivered');
    expect(delivered.at(-1)).toMatchObject({ jobId: job, data: { name: 'shared/AWS_DIAG', template: 'kube', machine: 'hopper-sandbox-kube', job } });
    nowhere(a, VALUE, dir);
  });

  it('a template may not name a shared secret the hopper does not hold', async () => {
    const { a, session } = await boot();
    const r = await a.ui<{ error: string }>('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['shared/NOPE'] }, { token: session });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/holds no secret shared\/NOPE/);
  });

  it('readers named leave the job\'s user out: Access refuses it; removed, nothing is given', async () => {
    const { a, session } = await boot();
    // Another user's id: the job's user is not among the readers.
    expect((await share(a, session, { action: 'set', name: 'AWS_DIAG', value: VALUE, readers: ['u-other'] })).body.shared?.[0]?.readers).toEqual(['u-other']);
    const { dir, token } = await kubeBox(a, session, ['shared/AWS_DIAG']);

    const denied = await helper(dir, ['get', 'shared/AWS_DIAG'], token);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/may not read shared_secret:AWS_DIAG/);
    expect((await a.events()).find((e) => e.type === 'vault.refused')).toMatchObject({ data: { name: 'shared/AWS_DIAG', reason: expect.stringMatching(/may not read/) } });

    // Every user again, then removed: nothing is given.
    await share(a, session, { action: 'set', name: 'AWS_DIAG', value: VALUE });
    expect(await helper(dir, ['get', 'shared/AWS_DIAG'], token)).toMatchObject({ code: 0, stdout: VALUE });
    expect((await share(a, session, { action: 'remove', name: 'shared/AWS_DIAG' })).body.shared).toEqual([]);
    const gone = await helper(dir, ['get', 'shared/AWS_DIAG'], token);
    expect(gone.code).not.toBe(0);
    expect(gone.stderr).toMatch(/holds no shared secret shared\/AWS_DIAG/);
    expect((await share(a, session, { action: 'remove', name: 'AWS_DIAG' })).status).toBe(404);
    nowhere(a, VALUE, dir);
  });

  it('the operator CLI shares a secret from stdin, lists it, and removes it', async () => {
    const { a } = await boot();
    const hopper = async (argv: string[], stdin = '') => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => stdin, out: (x) => out.push(x), err: (x) => err.push(x) };
      const code = await runCli([...argv, '--url', a.url], io);
      return { code, out: out.join(''), err: err.join('') };
    };
    expect(await hopper(['vault', 'set', 'AWS_DIAG', '--shared', '--scope', 'diagnostics', '--reader', 'u-other'], `${VALUE}\n`)).toMatchObject({ code: 0 });
    const listed = await hopper(['vault']);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as VaultView).shared).toEqual([expect.objectContaining({ name: 'shared/AWS_DIAG', scope: 'diagnostics', readers: ['u-other'] })]);
    expect(listed.out).not.toContain(VALUE);
    // --reader without --shared means nothing for a user's own secret: refused before any call.
    expect(await hopper(['vault', 'set', 'MINE', '--reader', 'u-other'], 'mine-0123456789')).toMatchObject({ code: 2, err: expect.stringMatching(/--reader/) });
    expect(await hopper(['vault', 'remove', 'AWS_DIAG', '--shared'])).toMatchObject({ code: 0 });
    expect((JSON.parse((await hopper(['vault'])).out) as VaultView).shared).toEqual([]);
  });
});
