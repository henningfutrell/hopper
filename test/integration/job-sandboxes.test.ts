// Issue #991, through the real composition root and the real HTTP server, with OpenFGA and the container runtime as
// doubles at their ports: a job that needs AWS asks the hopper for a sandbox (`sh "$HOPPER_SKILL" sandbox --needs …`,
// the real `hopper-skill`). The hopper makes or reuses the template, a person approves it unless skip template approval
// is on, a person approves the sandbox run unless skip sandbox approval is on, and the box starts.
//
// Feature: sandboxes start from jobs
//   Scenario: with sandbox YOLO on, a job that needs AWS gets a running box with no human step
//     Given an admin turns sandbox YOLO on
//     When a job runs `sandbox --needs "write/aws-account/123456789012" --wait`
//     Then the template is made and approved by skip template approval, its write profile with it
//     And the sandbox run is approved by skip sandbox approval, and the box starts
//     And the job's wait ends with the box's name; each auto-approval is an event that names its toggle
//     And the answer says the job is not on the box, so its commands do not reach it (issue #1009)
//     And the same job asking again gets the same box, and no second template
//   Scenario: with both toggles off, a person approves the template the job asked for; its run starts with that approval
//   Scenario: a repeat write ask on an approved account runs with zero clicks, until the approval is forgotten (issue #1001)
//   Scenario: a job says why it asks, and its plan for a change; the cards show it with the job (issue #1001)
//   Scenario: a person declines the sandbox run, and the job is told why
//   Scenario: the toggles are the admin's, a box action: shown in the vault's view, an event; an API token with no box grant refused
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('with sandbox YOLO on, a job that needs AWS gets a running box with no human step', async () => {
    const { a, token, runtime } = await boot();
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token })).status).toBe(200);
    const creds = await runningJob(a);
    const r = await waiting(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]).end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const [t] = await asked(a, token);
    expect(t).toMatchObject({ profiles: [AWS_WRITE], approval: { by: 'skip template approval' }, pending: { image: false, profiles: [] } });
    const v = await view(a, token);
    const [req] = v.sandboxRequests!;
    expect(req).toMatchObject({ template: t!.name, state: 'running', approvedBy: 'skip sandbox approval' });
    expect(runtime.boxes.has(req!.container!)).toBe(true);
    expect(r.stdout).toContain(`sandbox: box ${req!.container!} of template ${t!.name} runs, approved by skip sandbox approval`);
    // Issue #1009: the job is not on the box, and the answer says so: its commands do not reach the box.
    expect(r.stdout).toContain(`This job runs on machine local, not on box ${req!.container!}: its commands do not reach the box`);
    expect(r.stdout).toContain(`must run as a job on machine ${req!.container!}`);

    const events = await sandboxEvents(a);
    expect(events.find((e) => e.type === 'vault.approved')?.data).toMatchObject({ template: t!.name, by: 'skip template approval' });
    expect(events.find((e) => e.type === 'template.profile_approved')?.data).toMatchObject({ template: t!.name, operation: 'write', by: 'skip template approval' });
    expect(events.find((e) => e.type === 'vault.sandbox_approved')?.data).toMatchObject({ template: t!.name, by: 'skip sandbox approval' });
    expect(events.find((e) => e.type === 'vault.sandbox_started')?.data).toMatchObject({ template: t!.name, container: req!.container });

    // Asked again: the same box, the same template.
    const again = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(again.code, again.stdout).toBe(0);
    expect(again.stdout).toContain(`box ${req!.container!}`);
    expect((await asked(a, token)).length).toBe(1);
    expect([...runtime.boxes.keys()].filter((n) => n === req!.container)).toHaveLength(1);
  });

  it('with both toggles off, a person approves the template the job asked for, its run starts with that approval, and the job\'s wait ends', async () => {
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
    expect(end.stdout).toContain(`of template ${t!.name} runs, approved by the template's approval by `);
    const [req] = (await view(a, token)).sandboxRequests!;
    expect(req).toMatchObject({ state: 'running' });
    expect(runtime.boxes.size).toBe(1);
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

    // Another job asks the same: the approved template is used, and its run starts by the remembered approval.
    const other = await runningJob(a);
    const r = await waiting(a, other, ['sandbox', '--needs', NEEDS, ...ASK]).end;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('approved by a remembered write approval');
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
    expect(waits.stdout).toContain('waits for a person to approve the sandbox run on Access requests');
    const req = (await view(a, token)).sandboxRequests!.find((x) => x.state === 'waiting');
    expect((await a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve', id: req!.id }, { token })).status).toBe(200);
    await vi.waitFor(async () => expect((await view(a, token)).sandboxRequests!.find((x) => x.id === req!.id)?.state).toBe('running'));
    expect(runtime.boxes.size).toBeGreaterThanOrEqual(2);
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
    expect(first.stdout).toContain('waits for a person to approve the sandbox run on Access requests');
    const [req] = (await view(a, token)).sandboxRequests!;
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'decline', id: req!.id, reason: 'use the lab account' }, { token })).status).toBe(200);
    const r = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(r.code, r.stdout).toBe(1);
    expect(r.stdout + r.stderr).toContain('use the lab account');
    expect(runtime.boxes.size).toBe(0);
    expect((await a.ui('/ui/api/sandbox-requests', { action: 'approve', id: 'nope' }, { token })).status).toBe(404);
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
