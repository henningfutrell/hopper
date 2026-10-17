// Issue #991, through the real composition root and the real HTTP server, with OpenFGA and the container runtime as
// doubles at their ports: a job that needs AWS asks the hopper for a sandbox (`sh "$HOPPER_SKILL" sandbox --needs …`,
// the real `hopper-skill`). The hopper makes or reuses the template, a person approves it unless skip template approval
// is on, and a person approves the sandbox runs unless skip sandbox approval is on. Issue #1349: an approval starts no
// box; each step of the job runs in a sandbox of its own (test/integration/box-steps.test.ts).
//
// Feature: sandboxes start from jobs
//   Scenario: with sandbox YOLO on, a job that needs AWS gets its sandbox runs approved with no human step
//     Given an admin turns sandbox YOLO on
//     When a job runs `sandbox --needs "write/aws-account/123456789012" --wait`
//     Then the template is made and approved by skip template approval, its write profile with it
//     And the sandbox runs are approved by skip sandbox approval; no box starts, and none joins as a machine
//     And the job's wait ends; each auto-approval is an event that names its toggle
//     And the answer says how the job runs each command: a box step, in a sandbox of its own (issues #1004, #1349)
//     And the same job asking again gets the same request, and no second template
//   Scenario: with both toggles off, a person approves the template the job asked for; its runs are approved with that approval
//   Scenario: a repeat write ask on an approved account runs with zero clicks, until the approval is forgotten (issue #1001)
//   Scenario: a job says why it asks, and its plan for a change; the cards show it with the job (issue #1001)
//   Scenario: a person declines the sandbox run, and the job is told why
//   Scenario: a delegate approver approves the sandbox run with `hopper sandbox approve` and its refresh token alone; one whose
//     approver policy names the account is refused (issue #1138)
//   Scenario: the toggles are the admin's, a box action: shown in the vault's view, an event; an API token with no box grant refused
//
// Feature: sandboxes before the start (issue #1471)
//   Scenario: a job whose brief names a template is held before it starts until a person approves its sandbox runs
//     Given the user has the approved template kube
//     When a job whose brief says to work in a box of template `kube` is queued
//     Then the hopper asks for its sandbox runs of kube, and holds the job "awaiting its sandboxes"; it does not start
//     When a person approves the request on Access requests
//     Then the job starts, its sandbox runs of kube approved already
//   Scenario: a running job asks for the sandbox runs of a template by its name (`sandbox --template NAME`)
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { BEFORE_START_PURPOSE } from '../../src/users/sandbox-requests.ts';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { rawRequest } from '../support/http.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const NEEDS = 'write/aws-account/123456789012';
/** Why the job asks, and what the box will change (issue #1001): a need that changes an asset takes a plan. */
const ASK = ['--why', 'Create the bucket for the report', '--plan', 'aws s3 mb s3://report (undo: aws s3 rb s3://report)'];
const AWS_WRITE = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } } as const;

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

async function boot(): Promise<{ a: TestApp; token: string; runtime: FakeContainerRuntime }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const runtime = createFakeContainerRuntime();
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(3) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime } });
  apps.push(a);
  return { a, token: await a.login(), runtime };
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

/** `hopper-skill … --wait` in the background: when its watch is open, and its end. */
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
const sandboxEvents = async (a: TestApp) => (await a.events()).filter((e) => e.type.startsWith('vault.sandbox_') || e.type === 'vault.approved' || e.type === 'template.profile_approved');

describe('sandboxes start from jobs (issue #991)', () => {
  it('with sandbox YOLO on, a job that needs AWS gets its sandbox runs approved with no human step, and no box starts', async () => {
    const { a, token, runtime } = await boot();
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token })).status).toBe(200);
    const creds = await runningJob(a);
    const r = await waiting(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]).end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const [t] = await asked(a, token);
    expect(t).toMatchObject({ profiles: [AWS_WRITE], approval: { by: 'skip template approval' }, pending: { image: false, profiles: [] } });
    const v = await view(a, token);
    const [req] = v.sandboxRequests!;
    expect(req).toMatchObject({ template: t!.name, state: 'approved', approvedBy: 'skip sandbox approval' });
    expect(runtime.boxes.size).toBe(0);
    expect(r.stdout).toContain(`sandbox: the sandbox runs of template ${t!.name} are approved for this job, by skip sandbox approval.`);
    // Issue #1349: a sandbox never runs the job; each command runs as a box step, in a sandbox of its own.
    expect(r.stdout).toContain('never joins the hopper as a machine');
    expect(r.stdout).toContain(`sh "$HOPPER_STEP" box ${t!.name} --command`);

    const events = await sandboxEvents(a);
    expect(events.find((e) => e.type === 'vault.approved')?.data).toMatchObject({ template: t!.name, by: 'skip template approval' });
    expect(events.find((e) => e.type === 'template.profile_approved')?.data).toMatchObject({ template: t!.name, operation: 'write', by: 'skip template approval' });
    expect(events.find((e) => e.type === 'vault.sandbox_approved')?.data).toMatchObject({ template: t!.name, by: 'skip sandbox approval' });
    expect(events.find((e) => e.type === 'vault.sandbox_started')).toBeUndefined();

    // Asked again: the same request, the same template, still no box.
    const again = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(again.code, again.stdout).toBe(0);
    expect(again.stdout).toContain(`template ${t!.name} are approved`);
    expect((await asked(a, token)).length).toBe(1);
    expect((await view(a, token)).sandboxRequests).toHaveLength(1);
    expect(runtime.boxes.size).toBe(0);
  });

  it('with both toggles off, a person approves the template the job asked for, its runs are approved with that approval, and the job\'s wait ends', async () => {
    const { a, token, runtime } = await boot();
    const creds = await runningJob(a);
    const first = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(first.code, first.stdout).toBe(3);
    expect(first.stdout).toMatch(/^waiting: template asked-[0-9a-f]+ waits for a person on Access requests/);
    const [t] = await asked(a, token);
    expect(t!.approval).toBeUndefined();

    const done = waiting(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    await done.opened;
    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: t!.name }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'approve-profile', name: t!.name, ...AWS_WRITE }, { token })).status).toBe(200);
    // Issue #1001: the person approved the template this job asked for, so its run needs no second approval.
    const end = await done.end;
    expect(end.code, end.stdout + end.stderr).toBe(0);
    expect(end.stdout).toContain(`of template ${t!.name} are approved for this job, by the template's approval by `);
    const [req] = (await view(a, token)).sandboxRequests!;
    expect(req).toMatchObject({ state: 'approved' });
    expect(runtime.boxes.size).toBe(0);
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'approve', id: req!.id }, { token })).status).toBe(409);
  });

  it('a repeat write ask on an approved account runs with zero clicks: a person\'s write approval is remembered until it is forgotten', async () => {
    const { a, token, runtime } = await boot();
    const asker = await runningJob(a);
    const first = await skill(a, asker, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(first.code, first.stdout).toBe(3);
    const [t] = await asked(a, token);
    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: t!.name }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'approve-profile', name: t!.name, ...AWS_WRITE }, { token })).status).toBe(200);
    const remembered = (await view(a, token)).rememberedWrites;
    expect(remembered).toEqual([{ ...AWS_WRITE, by: expect.any(String), at: expect.any(String), expiresAt: expect.any(String) }]);

    // Another job asks the same: the approved template is used, and its runs are approved by the remembered approval.
    const other = await runningJob(a);
    const r = await waiting(a, other, ['sandbox', '--needs', NEEDS, ...ASK]).end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('approved for this job, by a remembered write approval');
    expect((await asked(a, token)).length).toBe(1);
    expect((await sandboxEvents(a)).filter((e) => e.type === 'vault.sandbox_approved').map((e) => e.data.by)).toContain('a remembered write approval');

    // Forgotten, the next job's run waits for a person again.
    const forgot = await a.ui<VaultView>('/ui/api/sandbox-approvals', { forgetWrite: AWS_WRITE }, { token });
    expect(forgot.status).toBe(200);
    expect(forgot.body.rememberedWrites).toEqual([]);
    expect((await a.events()).find((e) => e.type === 'vault.write_forgotten')?.data).toMatchObject({ ...AWS_WRITE, by: expect.any(String) });
    const third = await runningJob(a);
    const waits = await skill(a, third, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(waits.code, waits.stdout).toBe(3);
    expect(waits.stdout).toContain('wait for a person to approve them on Access requests');
    const req = (await view(a, token)).sandboxRequests!.find((x) => x.state === 'waiting');
    expect((await a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve', id: req!.id }, { token })).status).toBe(200);
    expect((await view(a, token)).sandboxRequests!.find((x) => x.id === req!.id)?.state).toBe('approved');
    expect(runtime.boxes.size).toBe(0);
  });

  it('a job says why it asks, and for a change what the box will do; the cards a person decides on show it with the job', async () => {
    const { a, token } = await boot();
    const creds = await runningJob(a);
    const noWhy = await skill(a, creds, ['sandbox', '--needs', NEEDS]);
    expect(noWhy.code, noWhy.stdout).toBe(1);
    expect(noWhy.stdout + noWhy.stderr).toContain('--why');
    const noPlan = await skill(a, creds, ['sandbox', '--needs', NEEDS, '--why', 'Create the bucket for the report']);
    expect(noPlan.code, noPlan.stdout).toBe(1);
    expect(noPlan.stdout + noPlan.stderr).toContain('--plan');
    expect((await asked(a, token)).length).toBe(0);

    expect((await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK])).code).toBe(3);
    const [t] = await asked(a, token);
    expect(t).toMatchObject({ purpose: 'Create the bucket for the report', plan: 'aws s3 mb s3://report (undo: aws s3 rb s3://report)', label: 'create-the-bucket-for-the-report' });
    expect(t!.askedByJob).toMatchObject({ id: expect.any(String) });

    expect((await a.ui('/ui/api/sandbox-approvals', { skipTemplateApproval: true }, { token })).status).toBe(200);
    const again = await runningJob(a);
    expect((await skill(a, again, ['sandbox', '--needs', 'write/aws-account/210987654321', '--why', 'Tag the bucket', '--plan', 'aws s3api put-bucket-tagging (undo: delete the tag)'])).code).toBe(3);
    const req = (await view(a, token)).sandboxRequests!.find((x) => x.state === 'waiting');
    expect(req).toMatchObject({ purpose: 'Tag the bucket', plan: 'aws s3api put-bucket-tagging (undo: delete the tag)' });
  });

  it('a person declines the sandbox run, and the job is told why', async () => {
    const { a, token, runtime } = await boot();
    expect((await a.ui('/ui/api/sandbox-approvals', { skipTemplateApproval: true }, { token })).status).toBe(200);
    const creds = await runningJob(a);
    const first = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(first.code, first.stdout).toBe(3);
    expect(first.stdout).toContain('wait for a person to approve them on Access requests');
    const [req] = (await view(a, token)).sandboxRequests!;
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'decline', id: req!.id, reason: 'use the lab account' }, { token })).status).toBe(200);
    const r = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout + r.stderr).toContain('use the lab account');
    expect(runtime.boxes.size).toBe(0);
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'approve', id: 'nope' }, { token })).status).toBe(404);
  });

  it('a delegate approver approves the sandbox run with its refresh token alone; one whose policy names the account is refused (issue #1138)', async () => {
    const { a, token, runtime } = await boot();
    expect((await a.ui('/ui/api/sandbox-approvals', { skipTemplateApproval: true }, { token })).status).toBe(200);
    const creds = await runningJob(a);
    expect((await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK])).code).toBe(3);
    const [req] = (await view(a, token)).sandboxRequests!;
    const delegate = async (deny: string[]) => {
      const minted = await a.ui<{ refresh: string }>('/ui/api/api-tokens', { action: 'mint', label: 'cos', preset: 'delegate-approver', deny }, { token });
      expect(minted.status).toBe(200);
      const file = join(temp('delegate-'), 'refresh');
      writeFileSync(file, minted.body.refresh, { mode: 0o600 });
      return file;
    };
    const cli = async (file: string, argv: string[]) => {
      const out: string[] = [], err: string[] = [];
      const code = await runCli(argv, { env: { HOPPER_REFRESH_TOKEN_FILE: file, HOPPER_URL: a.url }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) });
      return { code, out: out.join(''), err: err.join('') };
    };

    const prodOnly = await delegate(['123456789012']);
    expect(await cli(prodOnly, ['sandbox', 'approve', req!.id])).toMatchObject({ code: 2, err: expect.stringMatching(/refused \(403\).*approver policy denies 123456789012/) });
    expect(runtime.boxes.size).toBe(0);

    const file = await delegate(['prod']);
    const listed = await cli(file, ['sandbox', 'requests']);
    expect(JSON.parse(listed.out)).toEqual([expect.objectContaining({ id: req!.id, state: 'waiting' })]);
    const approved = await cli(file, ['sandbox', 'approve', req!.id]);
    expect(approved.code, approved.err).toBe(0);
    expect(readFileSync(file, 'utf8')).toMatch(/^hopper_rt_/);
    expect((await a.events()).find((e) => e.type === 'vault.sandbox_approved')?.data).toMatchObject({ by: expect.stringMatching(/^cos \(delegate of .+\)$/) });
  });

  it('the toggles are the admin\'s, a box action: shown in the vault\'s view and an event; an API token with no box grant is refused', async () => {
    const { a, token } = await boot();
    expect((await view(a, token)).sandboxApprovals).toEqual({ skipTemplateApproval: false, skipSandboxApproval: false, autoApprove: { low: true, medium: false, high: false }, rememberWritesHours: 168 });
    const set = await a.ui<VaultView>('/ui/api/sandbox-approvals', { yolo: true, skipSandboxApproval: false }, { token });
    expect(set.status).toBe(200);
    expect(set.body.sandboxApprovals).toEqual({ skipTemplateApproval: true, skipSandboxApproval: false, autoApprove: { low: true, medium: false, high: false }, rememberWritesHours: 168 });
    const policy = await a.ui<VaultView>('/ui/api/sandbox-approvals', { autoApprove: { low: false, high: true } }, { token });
    expect(policy.body.sandboxApprovals?.autoApprove).toEqual({ low: false, medium: false, high: true });
    expect((await a.ui('/ui/api/sandbox-approvals', { autoApprove: { extreme: true } }, { token })).status).toBe(400);
    // Issue #1001: how long a person's write approval is remembered; 0 keeps it until it is forgotten.
    const hours = await a.ui<VaultView>('/ui/api/sandbox-approvals', { rememberWritesHours: 24 }, { token });
    expect(hours.body.sandboxApprovals?.rememberWritesHours).toBe(24);
    expect((await a.ui('/ui/api/sandbox-approvals', { rememberWritesHours: -1 }, { token })).status).toBe(400);
    expect((await a.events()).find((e) => e.type === 'vault.sandbox_approvals_set')?.data).toMatchObject({ skipTemplateApproval: true, skipSandboxApproval: false });
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: 'yes' }, { token })).status).toBe(400);

    const minted = await a.ui<{ token: string }>('/ui/api/api-tokens', { action: 'mint', label: 'agent', scopes: ['*'], role: 'admin', box: false }, { token });
    expect(minted.status).toBe(200);
    const r = await rawRequest(a.url, { method: 'POST', path: '/ui/api/sandbox-approvals', headers: { authorization: `Bearer ${minted.body.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ yolo: true }) });
    expect(r.status, r.text).toBe(403);
  });
});

/** The user's approved template kube, of a vault secret only. */
async function kube(a: TestApp, token: string): Promise<void> {
  const edit = (body: Record<string, unknown>) => a.ui('/ui/api/vault', body, { token });
  expect((await edit({ action: 'set', name: 'KUBE_TOKEN', scope: 'lab cluster', value: 'lab-token-0123456789abcdef' })).status).toBe(200);
  expect((await edit({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] })).status).toBe(200);
  expect((await edit({ action: 'approve-template', name: 'kube' })).status).toBe(200);
}

describe('sandboxes before the start (issue #1471)', () => {
  it('a job whose brief names a template is held before it starts until a person approves its sandbox runs', async () => {
    const { a, token } = await boot();
    await kube(a, token);
    const job = await a.pull({ op: 'sleep', ms: 60000, brief: 'Work in a box of template `kube`.' });
    const held = await a.waitForStatus(job.id, 'held', 10000);
    expect(held.holdReason).toBe('awaiting its sandboxes: the sandbox runs of template kube wait for a person on Access requests');
    const [req] = (await view(a, token)).sandboxRequests!;
    expect(req).toMatchObject({ jobId: job.id, template: 'kube', state: 'waiting', purpose: BEFORE_START_PURPOSE });
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'approve', id: req!.id }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'running', 10000);
    expect((await view(a, token)).sandboxRequests).toEqual([expect.objectContaining({ id: req!.id, jobId: job.id, state: 'approved' })]);
  });

  it('a running job asks for the sandbox runs of a template by its name', async () => {
    const { a, token } = await boot();
    await kube(a, token);
    const creds = await runningJob(a);
    const ask = ['sandbox', '--template', 'kube', '--why', 'The brief says to work in a box of kube'];
    const first = await skill(a, creds, ask);
    expect(first.code, first.stdout).toBe(3);
    expect(first.stdout).toContain('waiting: the sandbox runs of template kube wait for a person to approve them on Access requests.');
    const [req] = (await view(a, token)).sandboxRequests!;
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'approve', id: req!.id }, { token })).status).toBe(200);
    const again = await skill(a, creds, ask);
    expect(again.code, again.stdout).toBe(0);
    expect(again.stdout).toContain('sh "$HOPPER_STEP" box kube --command');

    const none = await skill(a, creds, ['sandbox', '--template', 'nope', '--why', 'x']);
    expect(none.code).toBe(1);
    expect(none.stdout).toContain('no: there is no template nope.');
    const both = await skill(a, creds, ['sandbox', '--template', 'kube', '--needs', NEEDS, ...ASK]);
    expect(both.code).toBe(1);
    expect(both.stdout).toContain('no: give --template NAME or --needs, not both');
  });
});
