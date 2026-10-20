// The read-only check's integration tests (issue #716, item 4; issues #797, #715): a test app booted with a container
// runtime double whose check boxes run the real script with fake cloud tools, STS and a Kubernetes API faked on loopback,
// OpenFGA as a double, a read policy and the minting credentials; a running job with the real `hopper-skill`.
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { checkWait } from '../../src/domain/read-only-check.ts';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { templateReady as ready } from '../../src/domain/sandboxes-before-start.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from './fake-authorization-server.ts';
import { createFakeCloudTools, type FakeCloudTools } from './fake-cloud-tools.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from './fake-container-runtime.ts';
import { fakeKubeApi, fakeSts, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from './fake-mint-apis.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from './app.ts';
import { startVaultContainer, VAULT_KEY } from './vault-container.ts';
import { KEY } from './webhooks.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
/** Stops every app a test booted and removes what it made: each test file's `afterEach`. */
export async function stopAll(): Promise<void> {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
}

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export interface Booted { a: TestApp; token: string; runtime: FakeContainerRuntime; cloud: FakeCloudTools; kube: FakeApi; sts: FakeApi }

export const ACCOUNT = '123456789012';
export const KUBE_MINTING_TOKEN = 'check-minting-token-never-in-the-box';
export const AWS_MINTING_SECRET = 'check-minting-secret-never-in-the-box';

/** `container`: the vault in a container of its own (issue #586), holding the master key and the minting credentials. */
export async function boot(policy: string[], o: { container?: boolean } = {}): Promise<Booted> {
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
export async function runningJob(a: TestApp): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  const dir = temp('job-credentials-');
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return dir;
}

export type Run = { code: number; stdout: string; stderr: string };
const env = (a: TestApp, creds: string): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') });

export function skill(a: TestApp, creds: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: env(a, creds), encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

export function waiting(a: TestApp, creds: string, args: string[]): { opened: Promise<void>; end: Promise<Run> } {
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

export const asked = async (a: TestApp, token: string): Promise<TemplateView> =>
  (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((t) => t.name.startsWith('asked-'))!;
/**
 * Whether a step may run in a box of the template now (issue #1349: a sandbox runs one step; src/sandbox/need-steps.ts
 * `ready`): 200, or 409 with why not — its check, else that it is not approved.
 */
export const stepBox = async (a: TestApp, token: string, template: string): Promise<{ status: 200 | 409; body: { error?: string } }> => {
  const t = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body.templates.find((x) => x.name === template);
  if (t && ready(t, 'any job')) return { status: 200, body: {} };
  return { status: 409, body: { error: (t && checkWait(t)) ?? `the template ${template} is not approved` } };
};
export const vault = (a: TestApp, token: string, body: unknown) => a.ui<{ error: string }>('/ui/api/vault', body, { token });
export const NEEDS = ['sandbox-template', '--why', 'Read the lab for the report', '--needs', `read/cluster/lab read/aws-role/${ACCOUNT}/readonly`];
