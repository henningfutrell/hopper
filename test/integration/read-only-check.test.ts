// Issue #716, item 4, through the real composition root and the real HTTP server: a template a job asks for with read
// needs only takes a read-only check before its first box. The job runs the real `hopper-skill`. The container runtime is a
// double at its port (test/support/fake-container-runtime.ts) whose one-shot containers run the check's real script under
// `sh`, with fake aws, kubectl, helm and terraform (test/support/fake-cloud-tools.ts) that answer as under a read-only or a
// writable credential. OpenFGA is a double at the AuthorizationServer seam.
// Issue #797: the check box gets the read credentials its needs mint — an AWS read session, a Kubernetes token — from the
// real minting adapters against an STS and a Kubernetes API faked on loopback, after Access allowed the template each one.
// The fake tools answer only with those minted credentials, as the real ones do.
//
// Feature: the read-only check before a requested template's first box
//   Scenario: every write refused, every read works: the check passes and the template is ready
//     Given the read policy holds cluster/lab and aws-role/123456789012/*
//     And the vault holds a minting credential for cluster lab and one for aws-account 123456789012
//     When a job asks for read on cluster lab and aws-role 123456789012/readonly, with --wait
//     Then the template is approved by the read policy, and the job waits for its read-only check
//     And a box of it is refused, saying the check has not run
//     When the check pass runs
//     Then a check box ran the template's image with its tools, under the sandbox flags, with the check label, and is gone
//     And Access allowed the template each read before the vault minted it for the check box
//     And the box ran its probes with the minted AWS session and Kubernetes token, never with a minting credential
//     And the check passed: the template holds it, `template.checked` says so, and the job's wait ends with the template ready
//     And a box of it starts
//   Scenario: a write that goes through fails the check: the template takes no box until a person runs it again and it passes
//   Scenario: a save makes the check stale: it runs again on the template as it is now
//   Scenario: a template with a write need, and one a person saved, take no read-only check
//   Scenario: a check box that ends badly, or does not start, fails the check with the reason
//   Scenario: a check box no run holds (a hopper stopped mid-check) is removed, and its check runs again
//   Scenario: a need the vault cannot mint a credential for fails the check, saying why, and runs no check box
//   Scenario: a read Access does not allow fails the check, saying so, and mints nothing
//   Scenario: with the vault in a container of its own (issue #586), the check box gets its read credentials the same way
//   Scenario (issue #715): a terraform workspace's probes run with the AWS read session of the template's aws-role read need
//   Scenario (issue #715): a terraform workspace with no one aws-role read need beside it fails the check, saying so, and runs no check box
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccessView, TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { CHECK_LABEL } from '../../src/sandbox/check.ts';
import { BOX_LABEL } from '../../src/sandbox/launch.ts';
import { TOOLS_IMAGE } from '../../src/sandbox/tools.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { fakeKubeApi, fakeSts, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from '../support/fake-mint-apis.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { KEY } from '../support/webhooks.ts';

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

interface Booted { a: TestApp; token: string; runtime: FakeContainerRuntime; cloud: FakeCloudTools; kube: FakeApi; sts: FakeApi }

const ACCOUNT = '123456789012';
const KUBE_MINTING_TOKEN = 'check-minting-token-never-in-the-box';
const AWS_MINTING_SECRET = 'check-minting-secret-never-in-the-box';

/** `container`: the vault in a container of its own (issue #586), holding the master key and the minting credentials. */
async function boot(policy: string[], o: { container?: boolean } = {}): Promise<Booted> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const vault = o.container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
  if (vault) cleanups.push(() => { void vault.stop(); });
  const keys = vault ? { secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_VAULT_KEY: VAULT_KEY }, env: { HOPPER_VAULT_URL: vault.url } } : { secrets: { HOPPER_MASTER_KEY: KEY } };
  const kube = await fakeKubeApi();
  const sts = await fakeSts(ACCOUNT);
  cleanups.push(kube.close, sts.close);
  const cloud = createFakeCloudTools('read-only', { awsSessionToken: MINTED_AWS.SessionToken, kubeToken: MINTED_KUBE_TOKEN });
  cleanups.push(cloud.cleanup);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = cloud.runScript;
  const a = await startTestApp({ dbPath: db.dbPath, ...keys, plugins: { machines: lanes(2) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime } });
  apps.push(a);
  const token = await a.login();
  expect((await a.ui('/ui/api/vault', { action: 'set-read-policy', assets: policy }, { token })).status).toBe(200);
  expect((await a.ui('/ui/api/vault', { action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: kube.url, token: KUBE_MINTING_TOKEN }) }, { token })).status).toBe(200);
  expect((await a.ui('/ui/api/vault', { action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: AWS_MINTING_SECRET, Region: 'eu-west-1', Endpoint: sts.url }) }, { token })).status).toBe(200);
  return { a, token, runtime, cloud, kube, sts };
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

function skill(a: TestApp, creds: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: env(a, creds), encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

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

const asked = async (a: TestApp, token: string): Promise<TemplateView> =>
  (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((t) => t.name.startsWith('asked-'))!;
const launch = (a: TestApp, token: string, template: string) => a.ui<{ container: string; error: string }>('/ui/api/machines/sandbox', { template }, { token });
const vault = (a: TestApp, token: string, body: unknown) => a.ui<{ error: string }>('/ui/api/vault', body, { token });
const NEEDS = ['sandbox-template', '--needs', `read/cluster/lab read/aws-role/${ACCOUNT}/readonly`];

describe('the read-only check before a requested template\'s first box (issue #716)', () => {
  it('every write refused, every read works: the check passes and the template is ready', async () => {
    const { a, token, runtime, cloud, kube, sts } = await boot(['cluster/lab', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    const done = waiting(a, creds, NEEDS);
    await done.opened;
    const t = await asked(a, token);
    expect(t).toMatchObject({ readOnly: true, approval: { by: 'the read policy' } });
    expect(t.check).toBeUndefined();
    const refused = await launch(a, token, t.name);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(`waiting for the read-only check of ${t.name}: it has not run on this version yet`);

    await a.app.sandboxes.check();
    const end = await done.end;
    expect(end.code, end.stdout + end.stderr).toBe(0);
    expect(end.stdout).toContain(`template ${t.name} is ready`);

    // One check box: the template's image with its tools, the sandbox flags' spec, its script, the check label; then gone.
    const [box] = [...runtime.ran.values()];
    expect(runtime.ran.size).toBe(1);
    expect(box!.image.startsWith(`${TOOLS_IMAGE}:`)).toBe(true);
    expect(runtime.images.get(box!.image)).toContain('io.hopper.tools="aws helm kubectl"');
    expect(box!.labels[CHECK_LABEL]).toBeDefined();
    expect(box!.labels[BOX_LABEL]).toBeUndefined();
    expect(box!.user).toBe('agent');
    expect(box!.script).toContain('kubectl create namespace hopper-read-only-check --dry-run=server');
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);

    // The vault minted a read session and a read token for the check box (issue #797), after Access allowed each.
    expect(kube.seen.map((r) => [r.method, r.url, r.authorization])).toEqual([['POST', '/api/v1/namespaces/hopper/serviceaccounts/hopper-read/token', `Bearer ${KUBE_MINTING_TOKEN}`]]);
    expect(sts.seen).toHaveLength(1);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/readonly`);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain('RoleSessionName=hopper-read-only-check');
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain('arn:aws:iam::aws:policy/ReadOnlyAccess');
    const minted = (await a.events()).filter((e) => e.type === 'vault.check_minted');
    expect(minted.map((e) => e.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'kube', operation: 'read', asset: { kind: 'cluster', name: 'lab' }, template: t.name, check: box!.name, credential: 'KUBE_LAB', decision: expect.any(String), expiresAt: '2030-01-01T00:10:00Z' }),
      expect.objectContaining({ kind: 'aws', operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/readonly` }, template: t.name, check: box!.name, credential: 'AWS_LAB', decision: expect.any(String) }),
    ]));
    expect(minted).toHaveLength(2);
    const decisions = (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body.decisions;
    for (const e of minted) {
      expect(decisions.find((d) => d.id === (e.data as { decision: string }).decision)).toMatchObject({ allowed: true, check: { box: box!.name }, template: t.name, operation: 'read' });
    }
    // The box had the minted session and token, its region and its STS; never a minting credential.
    const boxEnv = JSON.stringify(box!.env);
    for (const minted of [MINTED_AWS.AccessKeyId, MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN, kube.url, 'eu-west-1', sts.url]) expect(boxEnv).toContain(minted);
    const kept = JSON.stringify([await a.events(), await asked(a, token), box!.script]);
    for (const secret of [MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN]) expect(kept).not.toContain(secret);
    for (const secret of [KUBE_MINTING_TOKEN, AWS_MINTING_SECRET]) expect(boxEnv + kept).not.toContain(secret);
    expect(cloud.calls().filter((c) => c.startsWith('aws ')).length).toBeGreaterThan(0);

    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ version: checked.savedAt, state: 'passed' });
    // Five for the cluster (kubectl and helm), five for the role (aws).
    expect(checked.check!.probes.length).toBe(10);
    expect(checked.check!.probes.every((p) => p.passed)).toBe(true);
    const event = (await a.events()).find((e) => e.type === 'template.checked');
    expect(event?.data).toEqual({ template: t.name, state: 'passed', failed: [] });

    expect((await launch(a, token, t.name)).status).toBe(200);
    // A passed check is not run again.
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(1);
  });

  it('a write that goes through fails the check: the template takes no box until a person runs it again and it passes', async () => {
    const { a, token, runtime, cloud } = await boot(['cluster/lab']);
    cloud.setMode('writable');
    const creds = await runningJob(a);
    expect((await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab'])).code).toBe(3);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check).toMatchObject({ state: 'failed' });
    const failed = ['kube.create-namespace on lab (allowed)', 'kube.delete-pod on lab (error)', 'helm.install on lab (allowed)'];
    expect((await a.events()).find((e) => e.type === 'template.checked')?.data).toEqual({ template: t.name, state: 'failed', failed });

    const refused = await launch(a, token, t.name);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(`it failed (${failed.join('; ')}). A person runs it again in Settings → Vault, or with hopper template check ${t.name}`);
    const told = await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    expect(told.code).toBe(3);
    expect(told.stdout).toContain(`waiting: template ${t.name} is approved; waiting for the read-only check of ${t.name}: it failed`);
    // A failed check is not run again by itself.
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(1);

    // The credential is made read-only; a person asks for the check again.
    cloud.setMode('read-only');
    expect((await vault(a, token, { action: 'check-template', name: t.name })).status).toBe(200);
    expect((await asked(a, token)).check).toBeUndefined();
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
    expect((await launch(a, token, t.name)).status).toBe(200);
    expect((await a.events()).find((e) => e.type === 'template.check_requested')?.data).toMatchObject({ template: t.name });
  });

  it('a save makes the check stale: it runs again on the template as it is now', async () => {
    const { a, token, runtime } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check?.state).toBe('passed');

    // A person adds terraform: its image waits for approval, and its check is stale.
    expect((await vault(a, token, { action: 'save-template', name: t.name, image: t.image, secrets: [], tools: ['helm', 'kubectl', 'terraform'] })).status).toBe(200);
    const saved = await asked(a, token);
    expect(saved.readOnly).toBe(true);
    expect((await launch(a, token, t.name)).status).toBe(409);
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(1);
    expect((await vault(a, token, { action: 'approve-template', name: t.name })).status).toBe(200);
    expect((await launch(a, token, t.name)).body.error).toContain('it has not run on this version yet');
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(2);
    expect((await asked(a, token)).check).toMatchObject({ version: saved.savedAt, state: 'passed' });
    expect((await launch(a, token, t.name)).status).toBe(200);
  });

  it('a template with a write need, and one a person saved, take no read-only check', async () => {
    const { a, token, runtime } = await boot(['cluster/*']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab write/cluster/lab']);
    const t = await asked(a, token);
    expect(t.readOnly).toBeUndefined();
    expect((await vault(a, token, { action: 'approve-template', name: t.name })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'approve-profile', name: t.name, operation: 'write', asset: { kind: 'cluster', name: 'lab' } }, { token })).status).toBe(200);
    expect((await launch(a, token, t.name)).status).toBe(200);

    expect((await vault(a, token, { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'cluster', name: 'lab' } }] })).status).toBe(200);
    expect((await vault(a, token, { action: 'approve-template', name: 'kube' })).status).toBe(200);
    expect((await launch(a, token, 'kube')).status).toBe(200);
    const no = await vault(a, token, { action: 'check-template', name: 'kube' });
    expect(no.status).toBe(400);
    expect(no.body.error).toBe('kube takes no read-only check: only a template a job asked for with read needs only does');
    await a.app.sandboxes.check();
    expect(runtime.ran.size).toBe(0);
  });

  it('a check box that ends badly, or does not start, fails the check with the reason', async () => {
    const { a, token, runtime, cloud } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    // Every probe line is there, but the script itself ended with 137 (killed): no pass.
    runtime.runScript = async (spec) => { const r = await cloud.runScript(spec); return { ...r, exit: 137 }; };
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'failed', problem: 'the check box ended with 137' });

    runtime.runScript = cloud.runScript;
    runtime.createFails = 'no space left on device';
    expect((await vault(a, token, { action: 'check-template', name: t.name })).status).toBe(200);
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'failed', probes: [], problem: 'the check box did not run: no space left on device' });
    expect(runtime.volumes.size).toBe(0);
    expect((await launch(a, token, t.name)).status).toBe(409);
  });

  it('a check box no run holds (a hopper stopped mid-check) is removed, and its check runs again', async () => {
    const { a, token, runtime } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    // As a hopper stopped mid-check leaves it: a check box, and the check `running`.
    const instanceId = a.app.instance.settings.instanceId();
    runtime.put({ name: 'hopper-check-left', image: 'i', network: 'n', volume: 'hopper-check-left-home', env: {}, labels: { [CHECK_LABEL]: instanceId }, limits: { cpus: 1, memoryMb: 1 }, user: 'agent', script: 'true' });
    expect(a.user().vault.recordCheck(t.name, { version: t.savedAt, state: 'running', at: t.savedAt, probes: [] })).toBe(true);

    await a.app.sandboxes.check();
    expect(runtime.boxes.has('hopper-check-left')).toBe(false);
    expect(runtime.volumes.has('hopper-check-left-home')).toBe(false);
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
  });
  it('a need the vault cannot mint a credential for fails the check, saying why, and runs no check box', async () => {
    const { a, token, runtime, kube } = await boot(['cluster/*', 'aws-account/*']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', `read/cluster/other read/aws-account/${ACCOUNT}`]);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check).toMatchObject({ state: 'failed', probes: [] });
    expect(t.check!.problem).toBe([
      'the check box gets no credential for read on cluster other: no minting credential mints for cluster other: a person adds one on Settings → Vault',
      `the check box gets no credential for read on aws-account ${ACCOUNT}: the vault mints a credential for read on an aws-role, a cluster or a namespace only`,
    ].join('; '));
    expect(runtime.ran.size).toBe(0);
    expect(kube.seen).toHaveLength(0);
    expect((await launch(a, token, t.name)).status).toBe(409);
  });

  it('a read Access does not allow fails the check, saying so, and mints nothing', async () => {
    const { a, token, runtime, kube } = await boot(['cluster/lab']);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/cluster/lab']);
    const t = await asked(a, token);
    const access = (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': token })).body;
    const approval = access.templates.find((x) => x.template === t.name)!.approvals[0]!;
    expect((await a.ui('/ui/api/access', { action: 'revoke', approval: approval.id }, { token })).status).toBe(200);

    await a.app.sandboxes.check();
    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ state: 'failed', probes: [] });
    expect(checked.check!.problem).toBe(`the check box gets no credential for read on cluster lab: Access denied it: template ${t.name} is not approved to read on cluster lab`);
    expect(runtime.ran.size).toBe(0);
    expect(kube.seen).toHaveLength(0);
    expect((await a.events()).find((e) => e.type === 'vault.check_mint_refused')?.data).toMatchObject({ template: t.name, mint: { kind: 'kube', operation: 'read', asset: { kind: 'cluster', name: 'lab' } }, decision: expect.any(String) });
  });

  it('with the vault in a container of its own (issue #586), the check box gets its read credentials the same way', async () => {
    const { a, token, runtime, kube, sts } = await boot(['cluster/lab', `aws-role/${ACCOUNT}/*`], { container: true });
    const creds = await runningJob(a);
    await skill(a, creds, NEEDS);
    await a.app.sandboxes.check();
    expect((await asked(a, token)).check).toMatchObject({ state: 'passed' });
    expect(kube.seen).toHaveLength(1);
    expect(sts.seen).toHaveLength(1);
    const env = JSON.stringify([...runtime.ran.values()][0]!.env);
    for (const minted of [MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN, kube.url, sts.url]) expect(env).toContain(minted);
    expect(env).not.toContain(KUBE_MINTING_TOKEN);
  });

  it('a terraform workspace\'s probes run with the AWS read session of the template\'s aws-role read need (issue #715)', async () => {
    const { a, token, runtime, cloud, sts } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/readonly`]);
    await a.app.sandboxes.check();
    const t = await asked(a, token);
    expect(t.check, JSON.stringify(t.check)).toMatchObject({ state: 'passed' });
    // One read session, minted for the role, after Access allowed it; the workspace takes that one.
    expect(sts.seen).toHaveLength(1);
    expect(decodeURIComponent(sts.seen[0]!.body)).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/readonly`);
    expect((await a.events()).filter((e) => e.type === 'vault.check_minted').map((e) => (e.data as { asset: unknown }).asset)).toEqual([{ kind: 'aws-role', name: `${ACCOUNT}/readonly` }]);
    const probes = t.check!.probes.filter((p) => p.asset === 'shop-prod');
    expect(probes.map((p) => [p.id, p.outcome])).toEqual(expect.arrayContaining([
      ['terraform.plan', 'allowed'], ['terraform.apply', 'denied'], ['terraform.apply-direct', 'denied'], ['terraform.state-rm', 'denied'], ['terraform.destroy', 'denied'],
    ]));
    // apply past the wrapper reached the real binary with the session, and the account refused it.
    expect(probes.find((p) => p.id === 'terraform.apply-direct')!.output).toContain('AccessDenied');
    expect(cloud.calls().filter((c) => c.startsWith('terraform apply'))).toHaveLength(1);
    expect(runtime.ran.size).toBe(1);
  });

  it('a terraform workspace with no one aws-role read need beside it fails the check, saying so, and runs no check box (issue #715)', async () => {
    const { a, token, runtime, sts } = await boot(['terraform-workspace/*', `aws-role/${ACCOUNT}/*`]);
    const creds = await runningJob(a);
    await skill(a, creds, ['sandbox-template', '--needs', 'read/terraform-workspace/shop-prod']);
    await a.app.sandboxes.check();
    const alone = await asked(a, token);
    expect(alone.check).toMatchObject({ state: 'failed', probes: [] });
    expect(alone.check!.problem).toBe('the check box gets no credential for read on terraform-workspace shop-prod: '
      + 'a terraform workspace is read with the AWS read session of the template\'s aws-role read need, and the template has none: ask for read on the aws-role its provider and state are read with');

    await skill(a, creds, ['sandbox-template', '--needs', `read/terraform-workspace/shop-prod read/aws-role/${ACCOUNT}/one read/aws-role/${ACCOUNT}/two`]);
    await a.app.sandboxes.check();
    const two = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((x) => x.name !== alone.name && x.name.startsWith('asked-'))!;
    expect(two.check).toMatchObject({ state: 'failed', probes: [] });
    expect(two.check!.problem).toBe('the check box gets no credential for read on terraform-workspace shop-prod: '
      + `a terraform workspace is read with the AWS read session of the template's aws-role read need, and the template has 2 (${ACCOUNT}/one, ${ACCOUNT}/two): ask for one`);
    expect(runtime.ran.size).toBe(0);
    expect(sts.seen).toHaveLength(2);
  });
});
