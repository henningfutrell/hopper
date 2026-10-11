// Issue #716, item 1, through the real composition root and the real HTTP server, with OpenFGA as a double at the
// AuthorizationServer seam: a running job asks the hopper for the sandbox template its work needs, and the hopper makes
// it. The job runs the real `hopper-skill` (issue #582). The hopper writes the template from the job's needs — the box
// image, no vault secret, one operation profile per need — and approves it with no person only when every need is a
// read inside the user's read policy. Anything else waits for a person on Settings → Vault (design.md "Templates on
// request").
//
// Feature: a job asks the hopper for the template its work needs
//   Scenario: read needs inside the read policy are approved with no person
//     Given the read policy holds cluster/lab and aws-role/123456789012/*
//     And minting credentials for cluster lab and aws-account 123456789012, so the read-only check box gets its read
//       credentials (issue #797)
//     And a job running on the hopper's machine
//     When the job runs `sh "$HOPPER_SKILL" sandbox-template --needs "read/cluster/lab read/aws-role/123456789012/readonly"`
//     Then the template is approved by the read policy, and the job waits for its read-only check (issue #716, item 4;
//       test/integration/read-only-check.test.ts)
//     When the check passes
//     Then the answer is 200: the template, approved by the read policy, and the skills its box loads
//     And the vault holds the template: the box image, the tools its needs use (issue #716, item 2), no secret, the two
//       read profiles, approved, nothing pending
//     And Access allows read on cluster lab for it
//     And a second job that asks for the same needs gets the same template, and no second one is made
//   Scenario: a write need waits for a person, and the job's wait ends when the person approves it
//     Given the read policy holds cluster/*
//     When the job asks for read and write on cluster lab, with --wait
//     Then it is told a person is asked: the template saved, nothing of it approved (the policy approves only all-read needs)
//     When an admin approves write on cluster lab for the template
//     Then the job's wait ends with the template ready
//   Scenario: with no read policy, even a read need waits for a person
//   Scenario: a template a person changed since a job asked for it is never widened back by a job
//   Scenario: a revoked template is not approved again by the policy
//   Scenario: needs the hopper cannot read are refused, saying how to write them
//   Scenario: the read policy is the admin's: set, shown in the vault's view, an event; an entry it cannot read refused
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessDecisionRecord, TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { fakeKubeApi, fakeSts } from '../support/fake-mint-apis.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const BOX = 'ghcr.io/henningfutrell/hopper:box-claude';
const LAB_READ = { operation: 'read', asset: { kind: 'cluster', name: 'lab' } } as const;
const LAB_WRITE = { operation: 'write', asset: { kind: 'cluster', name: 'lab' } } as const;
const AWS_READ = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/readonly' } } as const;

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function boot(policy?: string[]): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  // The read-only check's box runs its script with fake tools that refuse every write (issue #716, item 4).
  const cloud = createFakeCloudTools('read-only');
  cleanups.push(cloud.cleanup);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = cloud.runScript;
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(2) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime } });
  apps.push(a);
  const token = await a.login();
  if (policy) expect((await a.ui('/ui/api/vault', { action: 'set-read-policy', assets: policy }, { token })).status).toBe(200);
  // The read-only check box's read credentials (issue #797): minted from these, against an STS and a Kubernetes API on loopback.
  const kube = await fakeKubeApi();
  const sts = await fakeSts('123456789012');
  cleanups.push(kube.close, sts.close);
  expect((await a.ui('/ui/api/vault', { action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: kube.url, token: 'minting' }) }, { token })).status).toBe(200);
  expect((await a.ui('/ui/api/vault', { action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: '123456789012' }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: 'minting', Endpoint: sts.url }) }, { token })).status).toBe(200);
  return { a, token };
}

/** A job running on the hopper's own machine, and its credentials dir as the hopper keeps it: its proxy token and `hopper-skill`. */
async function runningJob(a: TestApp): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  const dir = temp('job-credentials-');
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return dir;
}

type Run = { code: number; stdout: string; stderr: string };
const env = (a: TestApp, creds: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') });

/** `hopper-skill`, as the job runs it. */
function skill(a: TestApp, creds: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: env(a, creds), encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

/** `hopper-skill … --wait` in the background: when its watch is open (it says so on stderr), and its end. */
function waiting(a: TestApp, creds: string, args: string[]): { opened: Promise<void>; end: Promise<Run> } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const end = new Promise<Run>((resolve) => {
    const p = spawn('sh', [join(creds, 'skill'), ...args, '--wait', '--timeout', '60'], { env: env(a, creds) });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.includes('wait: ')) open(); });
    p.on('close', (code) => { open(); resolve({ code: code ?? 1, stdout, stderr }); });
  });
  return { opened, end };
}

const view = async (a: TestApp, token: string): Promise<VaultView> => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
const asked = async (a: TestApp, token: string): Promise<TemplateView[]> => (await view(a, token)).templates.filter((t) => t.name.startsWith('asked-'));
const check = async (a: TestApp, token: string, template: string, profile: { operation: string; asset: { kind: string; name: string } }) =>
  (await a.ui<AccessDecisionRecord>('/ui/api/access', { action: 'check', template, ...profile }, { token })).body;

describe('a job asks the hopper for the template its work needs (issue #716)', () => {
  it('read needs inside the read policy are approved with no person; the same needs again get the same template', async () => {
    const { a, token } = await boot(['cluster/lab', 'aws-role/123456789012/*']);
    const creds = await runningJob(a);
    const first = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab read/aws-role/123456789012/readonly']);
    expect(first.code, first.stdout).toBe(3);
    expect(first.stdout).toMatch(/^waiting: template asked-[0-9a-f]+ is approved; waiting for the read-only check of asked-[0-9a-f]+: it has not run on this version yet/);
    await a.app.sandboxes.check();
    const r = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab read/aws-role/123456789012/readonly']);
    expect(r.code, r.stdout).toBe(0);
    const [t] = await asked(a, token);
    expect(t).toMatchObject({ image: BOX, tools: ['aws', 'helm', 'kubectl'], secrets: [], profiles: [LAB_READ, AWS_READ], approval: { image: BOX, tools: ['aws', 'helm', 'kubectl'], by: 'the read policy' }, pending: { secrets: [], image: false, profiles: [] } });
    expect(t!.savedBy).toMatch(/^job /);
    expect(r.stdout).toContain(`template ${t!.name} is ready`);
    expect(r.stdout).toContain('approved by the read policy');
    expect(r.stdout).toContain('sh "$HOPPER_SKILL" kube-diagnostics cluster/lab');
    expect(r.stdout).toContain('sh "$HOPPER_SKILL" aws-diagnostics aws-role/123456789012/readonly');
    expect(r.stdout).toContain(`hopper sandbox launch --template ${t!.name}`);
    expect((await check(a, token, t!.name, LAB_READ)).allowed).toBe(true);

    // The same needs, in another order and another job: the same template.
    const other = await runningJob(a);
    const again = await skill(a, other, ['sandbox-template', '--needs', 'read/aws-role/123456789012/readonly, read/cluster/lab']);
    expect(again.code, again.stdout).toBe(0);
    expect(again.stdout).toContain(`template ${t!.name} is ready`);
    expect((await asked(a, token)).length).toBe(1);
    const types = (await a.events()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['template.saved', 'vault.approved', 'template.profile_approved', 'skill.loaded']));
  });

  it('a write need waits for a person, and the job\'s wait ends when the person approves it', async () => {
    const { a, token } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    const first = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab write/cluster/lab']);
    expect(first.code, first.stdout).toBe(3);
    expect(first.stdout).toMatch(/^waiting: template asked-[0-9a-f]+ waits for a person in Settings → Vault/);
    expect(first.stdout).toContain('write on cluster lab');
    const [t] = await asked(a, token);
    // The policy approves only what is all read: the template waits as a whole, nothing of it approved.
    expect(t).toMatchObject({ profiles: [LAB_READ, LAB_WRITE], pending: { image: true, profiles: [LAB_READ, LAB_WRITE] } });
    expect(t!.approval).toBeUndefined();

    const done = waiting(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab write/cluster/lab']);
    await done.opened;
    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: t!.name }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'approve-profile', name: t!.name, ...LAB_WRITE }, { token })).status).toBe(200);
    const end = await done.end;
    expect(end.code, end.stdout + end.stderr).toBe(0);
    expect(end.stdout).toContain(`template ${t!.name} is ready`);
    expect(end.stdout).toContain('approved by a person');
    expect((await check(a, token, t!.name, LAB_WRITE)).allowed).toBe(true);
  });

  it('with no read policy, even a read need waits for a person', async () => {
    const { a, token } = await boot();
    const creds = await runningJob(a);
    const r = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    expect(r.code, r.stdout).toBe(3);
    expect(r.stdout).toContain('the read policy does not hold read on cluster lab');
    const [t] = await asked(a, token);
    expect(t!.approval).toBeUndefined();
    expect((await check(a, token, t!.name, LAB_READ)).allowed).toBe(false);
  });

  it('a template a person changed since a job asked for it is never widened back by a job; a revoked one is not approved again', async () => {
    const { a, token } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    // Approved by the policy; it waits for its read-only check (issue #716, item 4).
    expect((await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab'])).code).toBe(3);
    const [t] = await asked(a, token);
    expect(t!.approval?.by).toBe('the read policy');

    // A person revokes it: the policy does not approve it again.
    expect((await a.ui('/ui/api/vault', { action: 'revoke-template', name: t!.name }, { token })).status).toBe(200);
    const revoked = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    expect(revoked.code, revoked.stdout).toBe(3);
    expect((await asked(a, token))[0]!.approval).toBeUndefined();

    // A person narrows it to nothing: a job never puts the profile back.
    expect((await a.ui('/ui/api/vault', { action: 'save-template', name: t!.name, image: BOX, secrets: [], profiles: [] }, { token })).status).toBe(200);
    const changed = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    expect(changed.code, changed.stdout).toBe(1);
    expect(changed.stdout).toContain(`no: a person changed template ${t!.name}`);
    expect((await asked(a, token))[0]!.profiles).toEqual([]);
  });

  it('needs the hopper cannot read are refused, saying how to write them', async () => {
    const { a, token } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    for (const needs of [[], ['--needs', 'read cluster lab'], ['--needs', 'delete/cluster/lab'], ['--needs', 'read/planet/mars']]) {
      const r = await skill(a, creds, ['sandbox-template', ...needs]);
      expect(r.code, `${needs.join(' ')}: ${r.stdout}`).toBe(1);
      expect(r.stdout).toContain('--needs "read/cluster/NAME');
    }
    expect(await asked(a, token)).toEqual([]);
  });

  it('the read policy is the admin\'s: set, shown in the vault\'s view, an event; an entry it cannot read refused', async () => {
    const { a, token } = await boot();
    expect((await view(a, token)).readPolicy).toEqual([]);
    const set = await a.ui<VaultView>('/ui/api/vault', { action: 'set-read-policy', assets: ['cluster/lab', 'namespace/lab/*', 'aws-account/*'] }, { token });
    expect(set.status).toBe(200);
    expect(set.body.readPolicy).toEqual(['cluster/lab', 'namespace/lab/*', 'aws-account/*']);
    expect((await view(a, token)).readPolicy).toEqual(['cluster/lab', 'namespace/lab/*', 'aws-account/*']);
    expect((await a.events()).find((e) => e.type === 'vault.read_policy_set')?.data).toMatchObject({ assets: ['cluster/lab', 'namespace/lab/*', 'aws-account/*'] });
    for (const bad of [['planet/mars'], ['cluster'], ['*'], ['cluster/la*b']]) {
      expect((await a.ui('/ui/api/vault', { action: 'set-read-policy', assets: bad }, { token })).status, bad[0]).toBe(400);
    }
  });
});
