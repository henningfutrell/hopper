// Issue #871, through the real composition root, the real HTTP server, a real joined client and the real minting
// adapters (STS and GitHub faked on loopback; OpenFGA as a double at its seam): infrastructure changes that did not come
// through IaC or GitOps are tracked on Infra (design.md "Out-of-band changes"). A job's read-only check reports
// what it found; the hopper's one rule keeps the out-of-band ones.
//
// Feature: out-of-band changes are tracked, never silent
//   Background:
//     Given a job running on a box of the template deploy, which may read and apply aws-role/123456789012/deploy
//     And the controller identity system:serviceaccount:argocd:*
//   Scenario: drift and a write by no controller and no plan-bound credential are recorded, each an event the notifiers send
//     When the job reports an Argo CD app out of sync, a non-empty terraform plan, a console write and an Argo CD write
//     Then three changes are recorded, with who, what, when and the source signal; the Argo CD write is in band
//     And `infra.out_of_band_recorded` is on the job's timeline for each
//   Scenario: a write by the credential minted for an approved plan, while it was valid, is in band
//   Scenario: a report sent again records nothing twice; drift found again after its mark is a new change
//   Scenario: a person marks a change adopted, reverted, or accepted with a reason; once
//   Scenario: a signal that is not whole, a controller list of *, are refused, with why
//   Scenario: an outside collector reports with an API token whose grant has the scope out-of-band:signals (part 2)
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OutOfBandChange, OutOfBandView } from '../../src/domain/out-of-band.ts';
import type { InfraPlan } from '../../src/domain/infra-plans.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { fakeSts } from '../support/fake-mint-apis.ts';
import { connectGitHub } from '../support/github-account.ts';
import { boxes, helper, runningJob } from '../support/vault-box.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';

const ACCOUNT = '123456789012';
const ROLE = `aws-role/${ACCOUNT}/deploy`;
const A = 'a'.repeat(40);

let t: TestApp | undefined;
const box = boxes();
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await box.end();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; session: string; dir: string; job: string; token: string }> {
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
  await a.ui('/ui/api/blast-radius/settings', { gateAt: 'off' }, { token: session });
  const edit = async (body: Record<string, unknown>) => expect((await a.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
  await edit({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: 'minting-secret', Region: 'us-east-1', Endpoint: sts.url }) });
  const role = { kind: 'aws-role', name: `${ACCOUNT}/deploy` };
  await edit({ action: 'save-template', name: 'deploy', image: 'localhost/box-terraform:1', secrets: [], profiles: [{ operation: 'read', asset: role }, { operation: 'apply', asset: role }] });
  await edit({ action: 'approve-template', name: 'deploy' });
  for (const p of [{ operation: 'read', asset: role }, { operation: 'apply', asset: role }]) await edit({ action: 'approve-profile', name: 'deploy', ...p });
  const dir = await box.join(a, session, 'hopper-sandbox-deploy', 'deploy');
  const job = await runningJob(a, 'hopper-sandbox-deploy');
  expect((await a.ui('/ui/api/out-of-band', { action: 'controllers', identities: ['system:serviceaccount:argocd:*'] }, { token: session })).status).toBe(200);
  return { a, session, dir, job, token: box.tokenFileOf(a, job) };
}

const tokenOf = (a: TestApp, job: string) => proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job);

async function asJob(a: TestApp, job: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${a.url}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenOf(a, job)}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

interface Reported { recorded: OutOfBandChange[]; inBand: { source: string; key: string; why: string }[]; known: number }
const report = async (a: TestApp, job: string, signals: unknown[]): Promise<Reported> => {
  const r = await asJob(a, job, '/job/infra-signals', { signals });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as unknown as Reported;
};

const NOW = new Date().toISOString();
const OUT_OF_SYNC = { source: 'gitops', key: 'argocd/web', target: 'argocd app web', what: 'OutOfSync', at: NOW, detail: 'Deployment web: replicas 3 in git, 5 live' };
const DRIFT = { source: 'terraform-plan', key: 'uat-network', target: 'uat-network', what: '0 to add, 1 to change, 0 to destroy', at: NOW, detail: '~ aws_security_group.web' };
const CONSOLE = {
  source: 'cloudtrail', key: 'evt-console-1', target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress', who: `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/someone`, at: NOW,
};
const ARGO = { source: 'kube-audit', key: 'audit-1', target: 'deployments/web', what: 'patch', who: 'system:serviceaccount:argocd:argocd-application-controller', at: NOW };

const listed = async (a: TestApp, session: string) =>
  (await a.api<{ changes: OutOfBandView[]; controllers: string[] }>('GET', '/api/out-of-band', undefined, { 'x-hopper-session': session })).body;

describe('out-of-band changes', () => {
  it('records drift and a write by no controller and no plan-bound credential, each an event; a controller\'s write is in band', async () => {
    const { a, session, job } = await boot();
    const r = await report(a, job, [OUT_OF_SYNC, DRIFT, CONSOLE, ARGO]);
    expect(r.recorded.map((c) => c.source)).toEqual(['gitops', 'terraform-plan', 'cloudtrail']);
    expect(r.recorded[2]).toMatchObject({ target: 'sg-0abc', what: 'ec2:AuthorizeSecurityGroupIngress', who: CONSOLE.who, at: NOW, job });
    expect(r.recorded[2]).not.toHaveProperty('detail');
    expect(r.inBand).toEqual([{ source: 'kube-audit', key: 'audit-1', why: 'controller system:serviceaccount:argocd:*' }]);

    const view = await listed(a, session);
    expect(view.controllers).toEqual(['system:serviceaccount:argocd:*']);
    expect(view.changes).toHaveLength(3);
    expect(view.changes.find((c) => c.source === 'gitops')).toMatchObject({ detail: OUT_OF_SYNC.detail });
    expect(view.changes.every((c) => c.marked === undefined)).toBe(true);
    const events = (await a.events()).filter((e) => e.type === 'infra.out_of_band_recorded');
    expect(events).toHaveLength(3);
    expect(events.find((e) => e.data.source === 'cloudtrail')).toMatchObject({ jobId: job, data: { target: 'sg-0abc', who: CONSOLE.who, at: NOW, key: 'evt-console-1' } });
  });

  it('holds a write by the credential minted for an approved plan, while it was valid, in band', async () => {
    const { a, session, dir, token, job } = await boot();
    const plan = (await asJob(a, job, '/job/infra-plans', {
      tool: 'helm', asset: ROLE, target: 'web', repo: 'octo/infra', ref: 'issue-1', commit: A, text: 'default, web, Deployment (apps) has changed:\n-  replicas: 3\n+  replicas: 4',
    })).json.plan as InfraPlan;
    await a.ui('/ui/api/infra-plans', { action: 'approve', plan: plan.id }, { token: session });
    const minted = await helper(dir, ['aws', 'apply', ROLE, '--plan', plan.id], token);
    expect(minted.code, minted.stderr).toBe(0);
    const principal = `arn:aws:sts::${ACCOUNT}:assumed-role/deploy/hopper-${job}`;
    expect((await a.events()).filter((e) => e.type === 'vault.minted').at(-1)).toMatchObject({ data: { plan: plan.id, principal } });

    const r = await report(a, job, [{ ...CONSOLE, key: 'evt-apply-1', who: principal, at: new Date().toISOString() }]);
    expect(r.recorded).toEqual([]);
    expect(r.inBand).toEqual([{ source: 'cloudtrail', key: 'evt-apply-1', why: `apply of plan ${plan.id} by job ${job}` }]);
    // The same principal before the credential was minted is out of band.
    const before = new Date(Date.now() - 10 * 60_000).toISOString();
    expect((await report(a, job, [{ ...CONSOLE, key: 'evt-apply-2', who: principal, at: before }])).recorded).toHaveLength(1);
  });

  it('records nothing twice; drift found again after its mark is a new change; a person marks each once', async () => {
    const { a, session, job } = await boot();
    const first = await report(a, job, [OUT_OF_SYNC, CONSOLE]);
    expect(await report(a, job, [OUT_OF_SYNC, CONSOLE])).toMatchObject({ recorded: [], known: 2 });
    const [sync, write] = first.recorded as [OutOfBandChange, OutOfBandChange];

    const mark = (body: Record<string, unknown>) => a.ui('/ui/api/out-of-band', { action: 'mark', ...body }, { token: session });
    expect((await mark({ change: write.id, mark: 'accepted' })).status).toBe(400);
    expect((await mark({ change: write.id, mark: 'accepted', reason: 'break-glass fix during the outage' })).status).toBe(200);
    expect((await mark({ change: write.id, mark: 'reverted' })).status).toBe(409);
    expect((await mark({ change: '00000000-0000-4000-8000-000000000000', mark: 'adopted' })).status).toBe(404);
    expect((await mark({ change: sync.id, mark: 'adopted' })).status).toBe(200);
    const marks = (await a.events()).filter((e) => e.type === 'infra.out_of_band_marked');
    expect(marks.map((e) => e.data.mark)).toEqual(['accepted', 'adopted']);
    expect(marks[0]).toMatchObject({ jobId: job, data: { change: write.id, reason: 'break-glass fix during the outage', by: expect.any(String) } });

    const view = await listed(a, session);
    expect(view.changes.find((c) => c.id === write.id)?.marked).toMatchObject({ mark: 'accepted', reason: 'break-glass fix during the outage' });
    // The write stays recorded once; the app out of sync again after it was adopted is a new change.
    const again = await report(a, job, [OUT_OF_SYNC, CONSOLE]);
    expect(again.recorded.map((c) => c.source)).toEqual(['gitops']);
    expect(again.known).toBe(1);
  });

  it('refuses a signal that is not whole, and a controller list that names every principal', async () => {
    const { a, session, job } = await boot();
    const { who: _who, ...nobody } = CONSOLE;
    const bad = await asJob(a, job, '/job/infra-signals', { signals: [OUT_OF_SYNC, nobody] });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/^signal 2: who must name the principal/);
    expect((await asJob(a, job, '/job/infra-signals', { signals: [] })).status).toBe(400);
    expect((await listed(a, session)).changes).toEqual([]);

    const every = await a.ui('/ui/api/out-of-band', { action: 'controllers', identities: ['*'] }, { token: session });
    expect(every.status).toBe(400);
    expect((await listed(a, session)).controllers).toEqual(['system:serviceaccount:argocd:*']);
    expect((await a.events()).filter((e) => e.type === 'infra.controllers_changed')).toEqual([
      expect.objectContaining({ data: { from: [], to: ['system:serviceaccount:argocd:*'], by: expect.any(String) } }),
    ]);
  });

  it('takes a report from an outside collector with an API token, judged by the same rule; a grant without the scope is refused', async () => {
    const { a, session } = await boot();
    const mint = async (scopes: string[]) => {
      const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'drift collector', holder: 'ci', role: 'operator', scopes }, { token: session });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body as { token: string }).token;
    };
    const send = async (token: string, body: unknown) => {
      const res = await fetch(`${a.url}/ui/api/out-of-band/signals`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    const r = await send(await mint(['out-of-band:signals']), { signals: [DRIFT, CONSOLE, ARGO] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const recorded = r.json.recorded as OutOfBandChange[];
    expect(recorded.map((c) => c.source)).toEqual(['terraform-plan', 'cloudtrail']);
    expect(recorded[1]).toMatchObject({ target: 'sg-0abc', who: CONSOLE.who, reporter: 'drift collector' });
    expect(recorded[1]).not.toHaveProperty('job');
    expect(recorded[1]).not.toHaveProperty('detail');
    expect(r.json.inBand).toEqual([{ source: 'kube-audit', key: 'audit-1', why: 'controller system:serviceaccount:argocd:*' }]);

    const events = (await a.events()).filter((e) => e.type === 'infra.out_of_band_recorded');
    expect(events).toHaveLength(2);
    expect(events[1]).not.toHaveProperty('jobId');
    expect(events[1]).toMatchObject({ data: { source: 'cloudtrail', reporter: 'drift collector' } });
    expect(events[1]!.data).not.toHaveProperty('job');

    // The person marks it as any change; the mark is on no job's timeline.
    expect((await a.ui('/ui/api/out-of-band', { action: 'mark', change: recorded[1]!.id, mark: 'reverted' }, { token: session })).status).toBe(200);
    expect((await a.events()).find((e) => e.type === 'infra.out_of_band_marked')).not.toHaveProperty('jobId');
    expect((await listed(a, session)).changes.find((c) => c.id === recorded[1]!.id)).toMatchObject({ reporter: 'drift collector', marked: { mark: 'reverted' } });

    const outOfScope = await send(await mint(['out-of-band:read']), { signals: [DRIFT] });
    expect(outOfScope.status).toBe(403);
    expect(String(outOfScope.json.error)).toMatch(/do not cover out-of-band:signals/);
    expect((await send(await mint(['out-of-band:signals']), { signals: [] })).status).toBe(400);
  });
});
