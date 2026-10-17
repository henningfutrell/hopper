// Issue #1722, through the real composition root, the real HTTP server, a real joined client and the real minting
// adapters (STS and GitHub faked on loopback; OpenFGA as a double at its seam): infra applies off. An install whose
// infrastructure changes go only through CI turns infra applies off; then the vault mints no write, sync or apply, even
// for a current approved plan, and says that the change goes through CI. Reads are as before
// (design.md "Infra applies off: changes through CI only").
//
// Feature: infra applies off
//   Background:
//     Given the minting credential AWS_LAB for aws-account 123456789012
//     And the template deploy, approved, which declares read and apply on aws-role/123456789012/deploy
//     And a job running on a box of deploy, with a current plan a person approved
//   Scenario: on by default; off, the apply mints nothing and the refusal names CI; a read still mints; on again, it mints
//   Scenario: a body that is not `{ on: boolean }` is 400
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { fakeSts, type FakeApi } from '../support/fake-mint-apis.ts';
import { connectGitHub } from '../support/github-account.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';

const ACCOUNT = '123456789012';
const ROLE = `aws-role/${ACCOUNT}/deploy`;
const A = 'a'.repeat(40);
/** `terraform show -json` of a plan that adds one security group rule, with the MAP tag. */
const JSON_PLAN = JSON.stringify({
  format_version: '1.2', planned_values: {}, resource_changes: [{
    address: 'aws_security_group.a', mode: 'managed', type: 'aws_security_group', provider_name: 'registry.terraform.io/hashicorp/aws',
    change: { actions: ['create'], before: null, after: { name: 'a', tags: {}, tags_all: { 'map-migrated': 'migXWT2TUR4TJ' } }, after_unknown: {} },
  }],
});
const PLAN = {
  tool: 'terraform', asset: ROLE, target: 'uat-network', repo: 'octo/infra', ref: 'issue-1', commit: A,
  text: 'Terraform will perform the following actions:\n  + aws_security_group_rule.a\nPlan: 1 to add, 0 to change, 0 to destroy.', json: JSON_PLAN,
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

async function boot(): Promise<{ a: TestApp; session: string; dir: string; job: string; token: string; sts: FakeApi }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  const sts = await fakeSts(ACCOUNT);
  cleanups.push(sts.close);
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.heads = { 'octo/infra@issue-1': A };
  t = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer(), grokbot: { baseMs: 20 } },
  });
  const a = t;
  connectGitHub(a, ['octo/infra']);
  const session = await a.login();
  // An apply profile rates the box high (issue #605); the blast-radius gate is not under test here.
  await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session });
  const edit = async (body: Record<string, unknown>) => expect((await a.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
  await edit({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: 'minting-secret', Region: 'us-east-1', Endpoint: sts.url }) });
  const role = { kind: 'aws-role', name: `${ACCOUNT}/deploy` };
  await edit({ action: 'save-template', name: 'deploy', image: 'localhost/box-terraform:1', secrets: [], profiles: [{ operation: 'read', asset: role }, { operation: 'apply', asset: role }] });
  await edit({ action: 'approve-template', name: 'deploy' });
  for (const p of [{ operation: 'read', asset: role }, { operation: 'apply', asset: role }]) await edit({ action: 'approve-profile', name: 'deploy', ...p });
  const dir = await box.join(a, session, 'hopper-sandbox-deploy', 'deploy');
  const job = await runningJob(a, 'hopper-sandbox-deploy');
  return { a, session, dir, job, token: box.tokenFileOf(a, job), sts };
}

/** The job records its plan, as `curl` on the box does, with its proxy token; a person approves it. */
async function approvedPlan(a: TestApp, session: string, job: string): Promise<InfraPlan> {
  const res = await fetch(`${a.url}/job/infra-plans`, {
    method: 'POST', body: JSON.stringify(PLAN),
    headers: { authorization: `Bearer ${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}`, accept: 'application/json', 'content-type': 'application/json' },
  });
  expect(res.status).toBe(201);
  const plan = ((await res.json()) as { plan: InfraPlan }).plan;
  expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id }, { token: session })).status).toBe(200);
  return plan;
}

describe('infra applies off (issue #1722)', () => {
  it('is on by default; off, a current approved plan mints nothing and the refusal names CI; a read still mints; on again, it mints', async () => {
    const { a, session, dir, token, sts, job } = await boot();
    const view = async () => (await a.api('GET', '/api/infra-applies', undefined, { 'x-hopper-session': session })).body;
    expect(await view()).toEqual({ on: true });
    const plan = await approvedPlan(a, session, job);

    expect((await a.ui('/ui/api/infra-applies', { on: false }, { token: session })).body).toEqual({ on: false });
    expect((await a.ui('/ui/api/infra-applies', { on: false }, { token: session })).status).toBe(200);
    expect(await view()).toEqual({ on: false });
    const off = await helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);
    expect(off.code).not.toBe(0);
    expect(off.stderr).toMatch(/infra applies are off on this hopper: it mints no credential for apply on aws-role 123456789012\/deploy\. An infrastructure change goes through CI/);
    expect(sts.seen).toHaveLength(0);
    expect((await a.events()).filter((e) => e.type === 'vault.mint_refused').at(-1)).toMatchObject({ jobId: job, data: { mint: { operation: 'apply' }, reason: expect.stringMatching(/^infra applies are off/) } });
    expect((await helper(dir, ['aws', 'read', ROLE], token)).code).toBe(0);
    expect((await a.events()).filter((e) => e.type === 'infra.applies_changed').map((e) => e.data)).toEqual([{ on: false, by: expect.any(String) }]);

    expect((await a.ui('/ui/api/infra-applies', { on: true }, { token: session })).body).toEqual({ on: true });
    const on = await helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);
    expect(on.code, on.stderr).toBe(0);
  });

  it('refuses a body that is not { on: boolean }', async () => {
    const { a, session } = await boot();
    for (const bad of [{}, { on: 'off' }, { on: true, extra: 1 }]) {
      expect((await a.ui('/ui/api/infra-applies', bad, { token: session })).status, JSON.stringify(bad)).toBe(400);
    }
  });
});
