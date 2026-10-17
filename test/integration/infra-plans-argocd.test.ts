// Issue #959, through the real composition root, the real HTTP server, a real joined client and the real minting
// adapters (the Kubernetes API and GitHub faked on loopback; OpenFGA as a double at its seam): an Argo CD sync goes
// through the same plan gate as a terraform or helm apply (design.md "Infra plans: Argo CD syncs through the plan gate").
//
// Feature: Argo CD syncs through the plan gate
//   Background:
//     Given the minting credential KUBE_LAB for cluster lab
//     And the template gitops, approved, which declares sync on argocd-app/lab/web
//     And a job running on a box of gitops, granted the vault
//     And GitHub says octo/deploy issue-2 is at commit A
//   Scenario: a sync with no plan, an unapproved plan, a plan of another app or a moved head mints nothing, and the
//     cluster is not asked (the negative test of the issue's "Done when")
//   Scenario: a terraform plan for an Argo CD app is not kept
//   Scenario: a current, approved GitOps plan of the app mints a hopper-sync token in the argocd namespace, the audit naming the plan
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { fakeKubeApi, MINTED_KUBE_TOKEN } from '../support/fake-mint-apis.ts';
import { connectGitHub } from '../support/github-account.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const WEB = { kind: 'argocd-app', name: 'lab/web' };
const APP = 'argocd-app/lab/web';
const PLAN = {
  tool: 'gitops', asset: APP, target: 'argocd app web', repo: 'octo/deploy', ref: 'issue-2', commit: A,
  text: '===== apps/Deployment web/web ======\n<   replicas: 2\n>   replicas: 3',
};

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot() {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const kube = await fakeKubeApi();
  cleanups.push(kube.close);
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.heads = { 'octo/deploy@issue-2': A };
  t = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const a = t;
  connectGitHub(a, ['octo/deploy']);
  const session = await a.login();
  // A sync profile rates the box high (issue #605); the blast-radius gate is not under test here.
  await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session });
  const edit = async (body: Record<string, unknown>) => expect((await a.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
  await edit({ action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: kube.url, token: 'kube-minting-token' }) });
  const sync = { operation: 'sync', asset: WEB };
  await edit({ action: 'save-template', name: 'gitops', image: 'localhost/box-kubectl:1', secrets: [], profiles: [sync] });
  await edit({ action: 'approve-template', name: 'gitops' });
  await edit({ action: 'approve-profile', name: 'gitops', ...sync });
  const dir = await box.join(a, session, 'hopper-sandbox-gitops', 'gitops');
  const job = await runningJob(a, 'hopper-sandbox-gitops');
  return { a, session, dir, job, token: box.tokenFileOf(a, job), kube, github };
}

/** The job's own request to the hopper, as `curl` on the box makes it: its proxy token, JSON. */
async function asJob(a: TestApp, job: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);
  const res = await fetch(`${a.url}/job/infra-plans`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const record = async (a: TestApp, job: string, body: Record<string, unknown>): Promise<InfraPlan> => {
  const r = await asJob(a, job, body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.plan as InfraPlan;
};

describe('Argo CD syncs through the plan gate', () => {
  it('mints no sync without a current approved GitOps plan of the app, and asks the cluster nothing; then mints hopper-sync', async () => {
    const { a, session, dir, token, kube, job, github } = await boot();
    const none = await helper(dir, ['kube', 'sync', APP], token);
    expect(none.code).not.toBe(0);
    expect(none.stderr).toMatch(/no apply without a plan: sync on argocd-app lab\/web changes infrastructure/);

    const terraform = await asJob(a, job, { ...PLAN, tool: 'terraform', json: '{}' });
    expect(terraform.status).toBe(400);
    expect(terraform.json.error).toMatch(/^a plan for an argocd-app is a gitops plan/);

    const plan = await record(a, job, PLAN);
    expect((await helper(dir, ['kube', 'sync', APP, '--plan', plan.id], token)).stderr).toMatch(/is not approved/);
    const shop = await record(a, job, { ...PLAN, asset: 'argocd-app/lab/shop', target: 'argocd app shop' });
    for (const id of [plan.id, shop.id]) expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan: id }, { token: session })).status).toBe(200);
    expect((await helper(dir, ['kube', 'sync', APP, '--plan', shop.id], token)).stderr).toMatch(/is a plan for argocd-app lab\/shop/);
    github.heads = { 'octo/deploy@issue-2': B };
    expect((await helper(dir, ['kube', 'sync', APP, '--plan', plan.id], token)).stderr).toMatch(/the code moved since plan/);
    expect(kube.seen).toHaveLength(0);
    expect((await a.events()).filter((e) => e.type === 'vault.minted')).toHaveLength(0);

    github.heads = { 'octo/deploy@issue-2': A };
    const minted = await helper(dir, ['kube', 'sync', APP, '--plan', plan.id], token);
    expect(minted.code, minted.stderr).toBe(0);
    expect(JSON.parse(minted.stdout)).toMatchObject({ kind: 'ExecCredential', status: { token: MINTED_KUBE_TOKEN } });
    expect(kube.seen.filter((r) => r.url.endsWith('/token'))).toEqual([expect.objectContaining({ method: 'POST', url: '/api/v1/namespaces/argocd/serviceaccounts/hopper-sync/token' })]);
    expect((await a.events()).filter((e) => e.type === 'vault.minted')).toEqual([expect.objectContaining({
      jobId: job, data: expect.objectContaining({ kind: 'kube', operation: 'sync', asset: WEB, plan: plan.id, principal: 'system:serviceaccount:argocd:hopper-sync' }),
    })]);
  });
});
