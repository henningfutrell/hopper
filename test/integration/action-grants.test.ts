// Issue #2206, through the real composition root, the real HTTP server and the real `hopper-step`: a job's step needs an
// AWS action that no role it may use allows. It names the action and its resource; the hopper asks a person for exactly
// that, on Access requests, and the step waits. One grant, and the step runs in its need box with a session narrowed to
// the reads and the granted action, through the approval and the plan gate as every change; the apply is in the Infra
// changes feed. The container runtime is a double whose one-shot containers run the real scripts under `sh` with fake
// cloud tools; STS and GitHub are faked on loopback; OpenFGA is a double at its seam.
//
// Feature: action grants
//   Background:
//     Given the minting credential AWS_LAB for aws-account 123456789012
//     And the template act, approved, which declares apply on aws-role/123456789012/hopper-action
//     And a running job with a current plan of that asset a person approved
//   Scenario: the step's action waits for a person; one grant, and the step runs narrowed to it; the apply is in the
//     Infra changes feed; the same action again runs at once
//   Scenario: a declined action tells the step no; nothing is minted
//   Scenario: with infra applies off, no action grant is asked: the step is refused and says the change goes through CI
//   Scenario: a change on the action role with no --action is refused before anything is asked
//   The action check (part 2): IAM's policy simulation is answered on loopback beside STS
//   Scenario: a template request names an action its role does not allow: refused before a template is made, with the
//     need to ask for on the action role in its place
//   Scenario: a template request on the action role asks for the grant at once, beside the template
//   Scenario: a need step with no template yet asks for the template and the grant in one visit; both approved, it runs
//   The run card (part 3): the job's action asks are on its run card, and one approval grants them with the template
//   Scenario: one approve-run of the card approves the template and grants the action; the step runs, in the feed
//   Scenario: one decline-run of the card declines the action too; the step is told no
//   Issue #2370: a change narrowed to granted actions needs no infra plan; the grant approves it
//   Scenario: a node-group scale card with no plan goes from approved to applied with no other step
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InfraPlan, PlanApply } from '../../src/domain/infra-plans.ts';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { STEP_SCRIPT } from '../../src/windows-steps/script.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeCloudTools, type FakeCloudTools } from '../support/fake-cloud-tools.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { fakeSts, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from '../support/fake-mint-apis.ts';
import { connectGitHub } from '../support/github-account.ts';

const ACCOUNT = '123456789012';
const ROLE = `aws-role/${ACCOUNT}/hopper-action`;
const NEED = `apply/${ROLE}`;
const ARN = `arn:aws:eks:us-west-1:${ACCOUNT}:nodegroup/identity-eks/identity-eks-nodes/*`;
const SCALE = `eks:UpdateNodegroupConfig=${ARN}`;
const SCOPE = { role: `${ACCOUNT}/hopper-action`, action: 'eks:UpdateNodegroupConfig', resource: ARN };
const A = 'a'.repeat(40);
const PLAN = {
  tool: 'terraform', asset: ROLE, target: 'identity-eks-nodes', repo: 'octo/infra', ref: 'issue-1', commit: A,
  text: 'Terraform will perform the following actions:\n  ~ aws_eks_node_group.nodes\nPlan: 0 to add, 1 to change, 0 to destroy.',
  json: JSON.stringify({ format_version: '1.2', planned_values: {}, resource_changes: [{ address: 'aws_eks_node_group.nodes', mode: 'managed', type: 'aws_eks_node_group', provider_name: 'registry.terraform.io/hashicorp/aws', change: { actions: ['update'], before: { scaling_config: [{ desired_size: 3 }] }, after: { scaling_config: [{ desired_size: 6 }] }, after_unknown: {} } }] }),
};

type Run = { code: number; stdout: string; stderr: string };
interface Booted { a: TestApp; session: string; runtime: FakeContainerRuntime; cloud: FakeCloudTools; sts: FakeApi; creds: string; job: string }

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(o: { template?: false; iamAllows?: string[] } = {}): Promise<Booted> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const sts = await fakeSts(ACCOUNT, o.iamAllows ? { iamAllows: o.iamAllows } : {});
  cleanups.push(sts.close);
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.heads = { 'octo/infra@issue-1': A };
  const cloud = createFakeCloudTools('read-only', { awsSessionToken: MINTED_AWS.SessionToken, kubeToken: MINTED_KUBE_TOKEN });
  cleanups.push(cloud.cleanup);
  const runtime = createFakeContainerRuntime();
  runtime.runScript = (spec) => cloud.runScript({ ...spec, env: { ...spec.env, HOME: mkdtempSync(join(cloud.dir, 'home-')) } });
  const a = await startTestApp({
    dbPath: db.dbPath, plugins: { machines: lanes(2) },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime },
  });
  apps.push(a);
  connectGitHub(a, ['octo/infra']);
  const session = await a.login();
  const edit = async (body: Record<string, unknown>) => { const r = await a.ui('/ui/api/vault', body, { token: session }); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  await edit({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: 'minting-secret', Region: 'us-west-1', Endpoint: sts.url }) });
  const role = { kind: 'aws-role', name: SCOPE.role };
  if (o.template !== false) {
    await edit({ action: 'save-template', name: 'act', image: 'ghcr.io/henningfutrell/hopper:box-claude', secrets: [], profiles: [{ operation: 'apply', asset: role }] });
    await edit({ action: 'approve-template', name: 'act' });
    await edit({ action: 'approve-profile', name: 'act', operation: 'apply', asset: role });
  }
  const pulled = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(pulled.id, 'running', 10000);
  const creds = mkdtempSync(join(cloud.dir, 'job-'));
  writeFileSync(join(creds, 'token'), `${tokenOf(a, pulled.id)}\n`, { mode: 0o600 });
  writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
  return { a, session, runtime, cloud, sts, creds, job: pulled.id };
}

const tokenOf = (a: TestApp, job: string): string => proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);

/** The job records its plan with its proxy token; a person approves it. */
async function approvedPlan(b: Booted): Promise<InfraPlan> {
  const res = await fetch(`${b.a.url}/job/infra-plans`, { method: 'POST', body: JSON.stringify(PLAN), headers: { authorization: `Bearer ${tokenOf(b.a, b.job)}`, accept: 'application/json', 'content-type': 'application/json' } });
  expect(res.status, await res.clone().text()).toBe(201);
  const plan = ((await res.json()) as { plan: InfraPlan }).plan;
  const ok = await b.a.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id }, { token: b.session });
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return plan;
}

function step(b: Booted, args: string[]): { waiting: Promise<void>; end: Promise<Run> } {
  let told = (): void => {};
  const waiting = new Promise<void>((resolve) => { told = resolve; });
  const end = new Promise<Run>((resolve) => {
    const env = { PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(b.creds, 'token'), HOPPER_STEP_POLL_S: '1', TMPDIR: b.cloud.dir };
    const p = spawn('sh', [join(b.creds, 'step'), ...args], { env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.includes('waiting:')) told(); });
    p.on('close', (code) => { told(); resolve({ code: code ?? 1, stdout, stderr }); });
  });
  return { waiting, end };
}

const WHY = ['--why', 'Scale the node group to 6 nodes'];
const vaultOf = async (b: Booted): Promise<VaultView> => (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.session })).body;
const ofJob = async (b: Booted): Promise<DomainEvent[]> => (await b.a.events()).filter((e) => e.jobId === b.job);
const decide = (b: Booted, body: Record<string, unknown>) => b.a.ui<VaultView>('/ui/api/sandbox-requests', body, { token: b.session });

/** The job asks the skill broker, as hopper-skill does: a form, with its proxy token. */
async function skill(b: Booted, fields: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(`${b.a.url}/job/skill`, { method: 'POST', body: new URLSearchParams(fields), headers: { authorization: `Bearer ${tokenOf(b.a, b.job)}` } });
  return { status: res.status, text: await res.text() };
}
const simulations = (b: Booted): string[] => b.sts.seen.map((r) => decodeURIComponent(r.body)).filter((x) => x.includes('Action=SimulatePrincipalPolicy'));
const ABOUT = { why: WHY[1]!, plan: 'terraform apply of the approved plan: desired size 3 to 6, undone by a plan back to 3' };

describe('action grants (issue #2206)', () => {
  it('waits for a person to grant the exact action; one grant, and the step runs narrowed to it; the apply is in the Infra changes feed', async () => {
    const b = await boot();
    const plan = await approvedPlan(b);
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan-id', plan.id, '--command', 'aws sts get-caller-identity', '--wait', '60']);
    await run.waiting;

    // The ask names the role, the action and the resource; it is in Access requests, once.
    const v = await vaultOf(b);
    expect(v.actionAsks).toEqual([expect.objectContaining({ job: b.job, ...SCOPE, why: WHY[1] })]);
    expect((await ofJob(b)).filter((e) => e.type === 'vault.action_asked').map((e) => e.data)).toEqual([{ job: b.job, ...SCOPE, why: WHY[1] }]);
    expect(b.sts.seen).toHaveLength(0);

    // One grant: the step goes on by itself.
    const granted = await decide(b, { action: 'grant-action', job: b.job, grant: SCOPE });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body.actionAsks).toEqual([]);
    expect(granted.body.actionGrants).toEqual([expect.objectContaining({ ...SCOPE, by: expect.any(String), expiresAt: expect.any(String) })]);
    const r = await run.end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain('hopper-step: exit 0');

    // The session is the action role's, narrowed to the reads and the granted action on its resource.
    const assume = decodeURIComponent(b.sts.seen.at(-1)!.body.replace(/\+/g, ' '));
    expect(assume).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/hopper-action`);
    expect(assume).toContain('PolicyArns.member.1.arn=arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect(assume).toContain('"Action":"eks:UpdateNodegroupConfig"');
    expect(assume).toContain(`"Resource":"${ARN}"`);

    const events = await ofJob(b);
    expect(events.find((e) => e.type === 'vault.action_granted')?.data).toMatchObject({ job: b.job, ...SCOPE });
    expect(events.find((e) => e.type === 'vault.minted')?.data).toMatchObject({ operation: 'apply', plan: plan.id, actions: [{ action: SCOPE.action, resource: ARN }] });

    // The apply is in the Infra changes feed, with the action it was narrowed to.
    const feed = (await b.a.api<{ applies: PlanApply[] }>('GET', '/api/infra-plans', undefined, { 'x-hopper-session': b.session })).body;
    expect(feed.applies).toEqual([expect.objectContaining({ plan: plan.id, operation: 'apply', job: b.job, actions: [{ action: SCOPE.action, resource: ARN }] })]);

    // The same action again: covered by the grant, so the step runs at once and nothing more is asked.
    const again = await step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan-id', plan.id, '--command', 'aws sts get-caller-identity']).end;
    expect(again.code, again.stderr).toBe(0);
    expect(again.stderr).not.toContain('waiting:');
    expect((await ofJob(b)).filter((e) => e.type === 'vault.action_asked')).toHaveLength(1);
  });

  it('a declined action tells the step no; nothing is minted', async () => {
    const b = await boot();
    const plan = await approvedPlan(b);
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan-id', plan.id, '--command', 'true', '--wait', '60']);
    await run.waiting;
    expect((await decide(b, { action: 'decline-action', job: b.job, grant: SCOPE, reason: 'scale it in terraform' })).status).toBe(200);
    const r = await run.end;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a person declined eks:UpdateNodegroupConfig');
    expect(r.stderr).toContain('scale it in terraform');
    expect(b.sts.seen).toHaveLength(0);
    expect((await vaultOf(b)).actionAsks).toEqual([]);
    // A second decision of the same ask finds none waiting.
    expect((await decide(b, { action: 'grant-action', job: b.job, grant: SCOPE })).status).toBe(404);
  });

  it('with infra applies off, no action grant is asked: the step is refused and says the change goes through CI', async () => {
    const b = await boot();
    expect((await b.a.ui('/ui/api/infra-applies', { on: false }, { token: b.session })).status).toBe(200);
    const r = await step(b, ['need', NEED, '--action', SCALE, ...WHY, '--command', 'true', '--wait', '5']).end;
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/infra applies are off.*No action grant is asked for/s);
    expect((await vaultOf(b)).actionAsks).toEqual([]);
    expect((await ofJob(b)).filter((e) => e.type === 'vault.action_asked')).toHaveLength(0);
  });

  it('a change on the action role with no --action is refused before anything is asked; an action that is no IAM action too', async () => {
    const b = await boot();
    const bare = await step(b, ['need', NEED, ...WHY, '--command', 'true', '--wait', '5']).end;
    expect(bare.code).not.toBe(0);
    expect(bare.stdout + bare.stderr).toContain('only for the actions a person granted');
    const wild = await step(b, ['need', NEED, '--action', `eks:*=${ARN}`, ...WHY, '--command', 'true', '--wait', '5']).end;
    expect(wild.stdout + wild.stderr).toContain('no wildcard');
    expect((await vaultOf(b)).actionAsks).toEqual([]);
    expect(b.sts.seen).toHaveLength(0);
  });

  it('the action check: an action the role does not allow refuses the template request before a template is made', async () => {
    const b = await boot({ template: false, iamAllows: ['eks:UpdateNodegroupConfig'] });
    const deploy = `apply/aws-role/${ACCOUNT}/deploy`;
    const r = await skill(b, { name: 'sandbox-template', needs: deploy, actions: `eks:TagResource=${ARN} ${SCALE}`, ...ABOUT });
    expect(r.status, r.text).toBe(409);
    expect(r.text).toContain(`ready: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${ACCOUNT}/deploy: the role allows it`);
    expect(r.text).toContain(`cannot: eks:TagResource on ${ARN} as aws-role ${ACCOUNT}/deploy: the role does not allow it (IAM policy simulation). Ask for apply/aws-role/${ACCOUNT}/hopper-action with --action eks:TagResource=${ARN} in its place`);
    // IAM simulated the role itself, once per action, with a read session of hopper-read.
    expect(simulations(b)).toEqual([
      expect.stringContaining(`PolicySourceArn=arn:aws:iam::${ACCOUNT}:role/deploy`),
      expect.stringContaining(`PolicySourceArn=arn:aws:iam::${ACCOUNT}:role/deploy`),
    ]);
    expect(decodeURIComponent(b.sts.seen[0]!.body)).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/hopper-read`);
    const v = await vaultOf(b);
    expect(v.templates).toEqual([]);
    expect(v.actionAsks).toEqual([]);
  });

  it('the action check: a template request on the action role asks for the grant at once, beside the template', async () => {
    const b = await boot({ template: false, iamAllows: ['eks:UpdateNodegroupConfig'] });
    const r = await skill(b, { name: 'sandbox-template', needs: NEED, actions: SCALE, ...ABOUT });
    expect(r.status, r.text).toBe(202);
    expect(r.text).toContain(`waits: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${SCOPE.role}: a person grants it on Access requests, AWS actions (asked now)`);
    // The ask is on the job's run card, beside the template, and not a second item of Access requests.
    const v = await vaultOf(b);
    expect(v.runs).toEqual([expect.objectContaining({ jobId: b.job, actions: [expect.objectContaining({ job: b.job, ...SCOPE, why: WHY[1] })] })]);
    expect(v.actionAsks).toEqual([]);
    expect(v.templates).toEqual([expect.objectContaining({ askedBy: b.job, profiles: [{ operation: 'apply', asset: { kind: 'aws-role', name: SCOPE.role } }] })]);
    // Asked again: the same ask, not a second one; once granted, the check says so.
    await skill(b, { name: 'sandbox-template', needs: NEED, actions: SCALE, ...ABOUT });
    expect((await ofJob(b)).filter((e) => e.type === 'vault.action_asked')).toHaveLength(1);
    expect((await decide(b, { action: 'grant-action', job: b.job, grant: SCOPE })).status).toBe(200);
    const after = await skill(b, { name: 'sandbox-template', needs: NEED, actions: SCALE, ...ABOUT });
    expect(after.text).toContain(`ready: eks:UpdateNodegroupConfig on ${ARN} as aws-role ${SCOPE.role}: a person granted it`);
  });

  it('a need step with no template yet asks for the template and the grant in one visit; both approved, it runs', async () => {
    const b = await boot({ template: false, iamAllows: ['eks:UpdateNodegroupConfig'] });
    const plan = await approvedPlan(b);
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan', ABOUT.plan, '--plan-id', plan.id, '--command', 'aws sts get-caller-identity', '--wait', '60']);
    await run.waiting;
    const v = await vaultOf(b);
    expect(v.runs?.[0]?.actions).toEqual([expect.objectContaining({ job: b.job, ...SCOPE })]);
    const asked = v.templates.find((t) => t.askedBy === b.job);
    expect(asked, JSON.stringify(v.templates)).toBeDefined();
    const role = { kind: 'aws-role', name: SCOPE.role };
    expect((await decide(b, { action: 'grant-action', job: b.job, grant: SCOPE })).status).toBe(200);
    for (const body of [{ action: 'approve-template', name: asked!.name }, { action: 'approve-profile', name: asked!.name, operation: 'apply', asset: role }]) {
      const ok = await b.a.ui('/ui/api/vault', body, { token: b.session });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    }
    const r = await run.end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(decodeURIComponent(b.sts.seen.at(-1)!.body.replace(/\+/g, ' '))).toContain('"Action":"eks:UpdateNodegroupConfig"');
  });

  it('the run card: one approve-run approves the template and grants the action; the step runs, and the apply is in the feed', async () => {
    const b = await boot({ template: false, iamAllows: ['eks:UpdateNodegroupConfig'] });
    const plan = await approvedPlan(b);
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan', ABOUT.plan, '--plan-id', plan.id, '--command', 'aws sts get-caller-identity', '--wait', '60']);
    await run.waiting;
    const v = await vaultOf(b);
    expect(v.runs).toHaveLength(1);
    const card = v.runs![0]!;
    expect(card).toMatchObject({ jobId: b.job, waits: { template: true }, actions: [expect.objectContaining({ job: b.job, ...SCOPE, why: WHY[1] })] });
    expect(v.actionAsks).toEqual([]);

    // An agent's API token may not decide a card that asks for an AWS action: a person grants it.
    const minted = await b.a.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'agent', scopes: ['*'], minutes: 10, box: true }, { token: b.session });
    expect(minted.status, JSON.stringify(minted.body)).toBe(200);
    const byToken = await fetch(`${b.a.url}/ui/api/sandbox-requests`, { method: 'POST', body: JSON.stringify({ action: 'approve-run', job: b.job, template: card.template }), headers: { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' } });
    expect(byToken.status, await byToken.clone().text()).toBe(403);
    expect(await byToken.text()).toContain('a person decides it');

    // One approval of the card: nothing else is approved or granted by hand.
    const ok = await decide(b, { action: 'approve-run', job: b.job, template: card.template });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.runs).toEqual([]);
    expect(ok.body.actionGrants).toEqual([expect.objectContaining({ ...SCOPE, expiresAt: expect.any(String) })]);
    const r = await run.end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(decodeURIComponent(b.sts.seen.at(-1)!.body.replace(/\+/g, ' '))).toContain('"Action":"eks:UpdateNodegroupConfig"');
    expect((await ofJob(b)).find((e) => e.type === 'vault.action_granted')?.data).toMatchObject({ job: b.job, ...SCOPE });
    const feed = (await b.a.api<{ applies: PlanApply[] }>('GET', '/api/infra-plans', undefined, { 'x-hopper-session': b.session })).body;
    expect(feed.applies).toEqual([expect.objectContaining({ plan: plan.id, job: b.job, actions: [{ action: SCOPE.action, resource: ARN }] })]);
  });

  it('the run card: one decline-run declines the action too; the step is told no and nothing is minted', async () => {
    const b = await boot({ template: false, iamAllows: ['eks:UpdateNodegroupConfig'] });
    const plan = await approvedPlan(b);
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan', ABOUT.plan, '--plan-id', plan.id, '--command', 'true', '--wait', '60']);
    await run.waiting;
    const card = (await vaultOf(b)).runs![0]!;
    expect((await decide(b, { action: 'decline-run', job: b.job, template: card.template, reason: 'scale it in terraform' })).status).toBe(200);
    const r = await run.end;
    // A run card's decline is a person's deny at gate 2: the step is told no, and the action's ask is declined too.
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/\bno: /);
    expect((await ofJob(b)).find((e) => e.type === 'vault.action_declined')?.data).toMatchObject({ job: b.job, ...SCOPE, reason: 'scale it in terraform' });
    const v = await vaultOf(b);
    expect([v.runs, v.actionAsks, v.actionGrants]).toEqual([[], [], []]);
    expect(b.sts.seen.filter((x) => decodeURIComponent(x.body).includes(`RoleArn=arn:aws:iam::${ACCOUNT}:role/hopper-action`))).toHaveLength(0);
  });

  it('issue #2370: a node-group scale card with no infra plan goes from one approve-run to applied with no other step', async () => {
    const b = await boot({ template: false, iamAllows: ['eks:UpdateNodegroupConfig'] });
    const call = `aws eks update-nodegroup-config --cluster-name identity-eks --nodegroup-name identity-eks-nodes --scaling-config desiredSize=6`;
    const plan = `${call}; undone by the same call with desiredSize=3`;
    // The fake aws CLI answers who the session is: the session it runs under is what the test checks.
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan', plan, '--command', 'aws sts get-caller-identity', '--wait', '60']);
    await run.waiting;
    const card = (await vaultOf(b)).runs![0]!;
    expect(card).toMatchObject({ jobId: b.job, plan, actions: [expect.objectContaining({ job: b.job, ...SCOPE })] });

    const ok = await decide(b, { action: 'approve-run', job: b.job, template: card.template });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const r = await run.end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const assume = decodeURIComponent(b.sts.seen.at(-1)!.body.replace(/\+/g, ' '));
    expect(assume).toContain(`RoleArn=arn:aws:iam::${ACCOUNT}:role/hopper-action`);
    expect(assume).toContain('"Action":"eks:UpdateNodegroupConfig"');
    // The mint names the granted action and no plan; nothing was refused on the way.
    const events = await ofJob(b);
    expect(events.filter((e) => e.type === 'vault.mint_refused')).toEqual([]);
    const minted = events.find((e) => e.type === 'vault.minted')?.data as Record<string, unknown>;
    expect(minted).toMatchObject({ operation: 'apply', actions: [{ action: SCOPE.action, resource: ARN }] });
    expect(minted).not.toHaveProperty('plan');
  });

  it('issue #2370: a plan the step names is still checked, granted actions or not', async () => {
    const b = await boot();
    const run = step(b, ['need', NEED, '--action', SCALE, ...WHY, '--plan-id', 'no-such-plan', '--command', 'true', '--wait', '60']);
    await run.waiting;
    expect((await decide(b, { action: 'grant-action', job: b.job, grant: SCOPE })).status).toBe(200);
    const r = await run.end;
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('no plan no-such-plan');
  });
});
