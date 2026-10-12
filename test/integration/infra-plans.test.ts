// Issue #870, through the real composition root, the real HTTP server, a real joined client and the real minting
// adapters (STS and GitHub faked on loopback; OpenFGA as a double at its seam): no apply without a plan. A job records
// its plan as a plan record of its own; the vault mints a credential that can change infrastructure only for an ask that
// names a plan of that asset, made at the commit its branch is at now, not stale, and approved by a person
// (design.md "Infra plans: no apply without a plan").
//
// Feature: no apply without a plan
//   Background:
//     Given the minting credential AWS_LAB for aws-account 123456789012
//     And the template deploy, approved, which declares read and apply on aws-role/123456789012/deploy
//     And a job running on a box of deploy, granted the vault
//     And GitHub says octo/infra issue-1 is at commit A
//   Scenario: an apply that names no plan mints nothing (the negative test of the issue's "Done when")
//     When the job runs `$HOPPER_SECRET aws apply aws-role/123456789012/deploy`
//     Then it is refused: "no apply without a plan"
//     And STS is not asked
//   Scenario: a job records its plan; it is kept whole and shown, and its plan file comes back as it was put
//     When the job posts its terraform plan at commit A, with the plan file
//     Then the plan is kept with the job, the issue, the read credential it was made with, and its expiry
//     And Infra changes lists it, not approved; and `infra.plan_recorded` is on the job's timeline
//   Scenario: an unapproved plan mints nothing; a person approves it once
//   Scenario: the code moved since the plan: the apply is refused, and STS is not asked
//   Scenario: a current, approved plan mints the write credential, and the audit names the plan
//   Scenario: a plan for another asset, and a plan that is not whole, are refused
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InfraPlan, PlanView } from '../../src/domain/infra-plans.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { fakeSts, type FakeApi } from '../support/fake-mint-apis.ts';
import { connectGitHub } from '../support/github-account.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';

const ACCOUNT = '123456789012';
const ROLE = `aws-role/${ACCOUNT}/deploy`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const FILE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 255]);

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; session: string; dir: string; job: string; token: string; sts: FakeApi; github: FakeForge }> {
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
    seams: { authorizationServer: createFakeAuthorizationServer() },
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
  return { a, session, dir, job, token: box.tokenFileOf(a, job), sts, github };
}

const tokenOf = (a: TestApp, job: string) => proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);

/** The job's own request to the hopper, as `curl` on the box makes it: its proxy token, JSON. */
async function asJob(a: TestApp, job: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${a.url}${path}`, {
    method, headers: { authorization: `Bearer ${tokenOf(a, job)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const PLAN = {
  tool: 'terraform', asset: ROLE, target: 'uat-network', repo: 'octo/infra', ref: 'issue-1', commit: A, pullRequest: 4,
  read: `read/aws-role/${ACCOUNT}/deploy`, text: 'Terraform will perform the following actions:\n  + aws_security_group_rule.a\nPlan: 1 to add, 0 to change, 0 to destroy.',
  file: FILE.toString('base64'),
};

const record = async (a: TestApp, job: string, body: Record<string, unknown> = PLAN): Promise<InfraPlan> => {
  const r = await asJob(a, job, 'POST', '/job/infra-plans', body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.plan as InfraPlan;
};

describe('no apply without a plan', () => {
  it('refuses an apply that names no plan, and asks STS nothing', async () => {
    const { a, dir, token, sts, job } = await boot();
    const r = await helper(dir, ['aws', 'apply', ROLE], token);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no apply without a plan: apply on aws-role 123456789012\/deploy changes infrastructure/);
    expect(sts.seen).toHaveLength(0);
    expect((await a.events()).find((e) => e.type === 'vault.mint_refused')).toMatchObject({ jobId: job, data: { mint: { operation: 'apply' }, reason: expect.stringMatching(/^no apply without a plan/) } });
    // A read needs no plan.
    expect((await helper(dir, ['aws', 'read', ROLE], token)).code).toBe(0);
  });

  it('keeps a job\'s plan whole, lists it in Infra changes, and gives its plan file back as it was put', async () => {
    const { a, session, job } = await boot();
    const plan = await record(a, job);
    expect(plan).toMatchObject({ tool: 'terraform', asset: { kind: 'aws-role', name: `${ACCOUNT}/deploy` }, target: 'uat-network', repo: 'octo/infra', ref: 'issue-1', commit: A, pullRequest: 4, read: PLAN.read, job, file: { size: FILE.length } });
    expect(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt)).toBe(60 * 60 * 1000);

    const listed = (await a.api<{ plans: PlanView[] }>('GET', '/api/infra-plans', undefined, { 'x-hopper-session': session })).body.plans;
    expect(listed).toEqual([expect.objectContaining({ id: plan.id, target: 'uat-network' })]);
    expect(listed[0]).not.toHaveProperty('approval');
    expect(listed[0]).not.toHaveProperty('text');
    expect((await a.api<{ plan: InfraPlan }>('GET', `/api/infra-plans/${plan.id}`, undefined, { 'x-hopper-session': session })).body.plan.text).toBe(PLAN.text);

    const file = await fetch(`${a.url}/job/infra-plans/${plan.id}?file=1`, { headers: { authorization: `Bearer ${tokenOf(a, job)}` } });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(FILE);
    expect((await a.events()).find((e) => e.type === 'infra.plan_recorded')).toMatchObject({ jobId: job, data: { plan: plan.id, tool: 'terraform', target: 'uat-network', commit: A, file: true } });
  });

  it('mints nothing for an unapproved plan, nor when the code moved; mints for a current approved plan, the audit naming it', async () => {
    const { a, session, dir, token, sts, job, github } = await boot();
    const plan = await record(a, job);

    const unapproved = await helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);
    expect(unapproved.code).not.toBe(0);
    expect(unapproved.stderr).toMatch(/is not approved/);

    expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id }, { token: session })).status).toBe(200);
    expect((await a.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id }, { token: session })).status).toBe(409);
    expect((await a.events()).find((e) => e.type === 'infra.plan_approved')).toMatchObject({ jobId: job, data: { plan: plan.id, by: expect.any(String) } });

    github.heads = { 'octo/infra@issue-1': B };
    const moved = await helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);
    expect(moved.code).not.toBe(0);
    expect(moved.stderr).toMatch(/the code moved since plan .*Plan again/);
    expect(sts.seen).toHaveLength(0);

    github.heads = { 'octo/infra@issue-1': A };
    const minted = await helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);
    expect(minted.code, minted.stderr).toBe(0);
    expect(JSON.parse(minted.stdout)).toMatchObject({ Version: 1, AccessKeyId: expect.any(String) });
    expect(sts.seen).toHaveLength(1);
    expect((await a.events()).filter((e) => e.type === 'vault.minted').at(-1)).toMatchObject({ jobId: job, data: { operation: 'apply', plan: plan.id } });
  });

  it('refuses a plan for another asset, and a plan that is not whole', async () => {
    const { a, session, dir, token, job } = await boot();
    const other = await record(a, job, { ...PLAN, asset: `aws-role/${ACCOUNT}/other` });
    await a.ui('/ui/api/infra-plans', { action: 'approve', plan: other.id }, { token: session });
    expect((await helper(dir, ['aws', 'apply', ROLE, '--plan', other.id], token)).stderr).toMatch(/is a plan for aws-role 123456789012\/other/);

    const bad = await asJob(a, job, 'POST', '/job/infra-plans', { ...PLAN, commit: 'abc' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^commit must be/);
    expect((await asJob(a, job, 'POST', '/job/infra-plans', { ...PLAN, file: 'not base64!' })).status).toBe(400);
  });
});
