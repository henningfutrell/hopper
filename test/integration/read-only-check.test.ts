// Issue #716, item 4, through the real composition root and the real HTTP server: a template a job asks for with read
// needs only takes a read-only check before its first box. The job runs the real `hopper-skill`. The container runtime is a
// double at its port (test/support/fake-container-runtime.ts) whose one-shot containers run the check's real script under
// `sh`, with fake aws, kubectl, helm and terraform (test/support/fake-cloud-tools.ts) that answer as under a read-only or a
// writable credential. OpenFGA is a double at the AuthorizationServer seam.
//
// Feature: the read-only check before a requested template's first box
//   Scenario: every write refused, every read works: the check passes and the template is ready
//     Given the read policy holds cluster/lab and aws-account/*
//     When a job asks for read on cluster lab and aws-account 123456789012, with --wait
//     Then the template is approved by the read policy, and the job waits for its read-only check
//     And a box of it is refused, saying the check has not run
//     When the check pass runs
//     Then a check box ran the template's image with its tools, under the sandbox flags, with the check label, and is gone
//     And the check passed: the template holds it, `template.checked` says so, and the job's wait ends with the template ready
//     And a box of it starts
//   Scenario: a write that goes through fails the check: the template takes no box until a person runs it again and it passes
//   Scenario: a save makes the check stale: it runs again on the template as it is now
//   Scenario: a template with a write need, and one a person saved, take no read-only check
//   Scenario: a check box that ends badly, or does not start, fails the check with the reason
//   Scenario: a check box no run holds (a hopper stopped mid-check) is removed, and its check runs again
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { CHECK_LABEL } from '../../src/sandbox/check.ts';
import { BOX_LABEL } from '../../src/sandbox/launch.ts';
import { TOOLS_IMAGE } from '../../src/sandbox/tools.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
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

interface Booted { a: TestApp; token: string; runtime: FakeContainerRuntime; cloud: FakeCloudTools }

async function boot(policy: string[]): Promise<Booted> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const cloud = createFakeCloudTools('read-only');
  cleanups.push(cloud.cleanup);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = cloud.runScript;
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(2) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime } });
  apps.push(a);
  const token = await a.login();
  expect((await a.ui('/ui/api/vault', { action: 'set-read-policy', assets: policy }, { token })).status).toBe(200);
  return { a, token, runtime, cloud };
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
const NEEDS = ['sandbox-template', '--needs', 'read/cluster/lab read/aws-account/123456789012'];

describe('the read-only check before a requested template\'s first box (issue #716)', () => {
  it('every write refused, every read works: the check passes and the template is ready', async () => {
    const { a, token, runtime } = await boot(['cluster/lab', 'aws-account/*']);
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

    const checked = await asked(a, token);
    expect(checked.check).toMatchObject({ version: checked.savedAt, state: 'passed' });
    // Five for the cluster (kubectl and helm), five for the account (aws).
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
});
