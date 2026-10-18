// Issue #655 part 16: the request's capabilities against the stamp's, at the skill broker and the step route, through
// the real daemon, store and HTTP edge, with OpenFGA and the container runtime as doubles at their ports. A job asks only
// for what its trust stamp may: a need whose operation profile has a minimum trust above the job's level is refused by
// policy before any template is made for it, before Jev or a person reads it, and the job's trust stays.
//
// Feature: gate 2 checks a request against the stamp
//   Scenario: a need above the job's trust is refused before a template is made
//     Given sandbox YOLO on, and the minimum trust owner to write on the AWS account
//     When a running job below owner asks `sandbox --needs "write/aws-account/…"`, or a need step of it
//     Then each is refused (403) with why, no template is asked, and the job's trust stamp is as it was
//     When the admin clears the minimum
//     Then the same ask is approved by skip sandbox approval
//     When the admin sets the minimum again
//     Then the job's approved run of that template runs no box step
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { rawRequest } from '../support/http.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const NEEDS = 'write/aws-account/123456789012';
const ASK = ['--why', 'Create the bucket for the report', '--plan', 'aws s3 mb s3://report (undo: aws s3 rb s3://report)'];
const ACCOUNT = { kind: 'aws-account', name: '123456789012' } as const;

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(3) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: createFakeContainerRuntime() } });
  apps.push(a);
  return { a, token: await a.login() };
}

type Run = { code: number; stdout: string; stderr: string };

function skill(a: TestApp, creds: string, args: string[]): Promise<Run> {
  const env = { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') };
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

describe('gate 2 checks a request against the stamp (issue #655 part 16)', () => {
  it('refuses a need above the job\'s trust before a template is made, and lets it once the minimum is cleared', async () => {
    const { a, token } = await boot();
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/access', { action: 'min-trust', operation: 'write', asset: ACCOUNT, level: 'owner' }, { token })).status).toBe(200);
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    const running = await a.waitForStatus(job.id, 'running', 10000);
    const level = a.user().store.jobs.trustLevel(running);
    expect(level).toBeDefined();
    expect(level).not.toBe('owner');
    const proxy = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
    const creds = mkdtempSync(join(tmpdir(), 'job-credentials-'));
    cleanups.push(() => rmSync(creds, { recursive: true, force: true }));
    writeFileSync(join(creds, 'token'), `${proxy}\n`, { mode: 0o600 });
    writeFileSync(join(creds, 'skill'), SKILL_SCRIPT, { mode: 0o700 });

    const refused = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(`the job's trust stamp is ${level}, below the minimum trust owner to write on aws-account 123456789012`);
    const step = await rawRequest(a.url, { method: 'POST', path: `/job/step?needs=${encodeURIComponent(NEEDS)}&key=step-0001&command=true`, headers: { authorization: `Bearer ${proxy}` } });
    expect(step.status).toBe(403);
    expect(step.text).toContain('below the minimum trust owner');
    const vault = async () => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
    expect((await vault()).templates.filter((t) => t.name.startsWith('asked-'))).toEqual([]);
    expect((await a.events()).filter((e) => e.type === 'job.trust_lowered' || e.type === 'vault.sandbox_requested')).toEqual([]);
    expect(a.user().store.jobs.trustLevel(a.user().store.jobs.get(job.id)!)).toBe(level);

    expect((await a.ui('/ui/api/access', { action: 'min-trust', operation: 'write', asset: ACCOUNT, level: null }, { token })).status).toBe(200);
    const allowed = await skill(a, creds, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(allowed.code, allowed.stdout + allowed.stderr).toBe(0);
    const [request] = (await vault()).sandboxRequests!;
    expect(request).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    expect(a.user().sandboxRequests.runnable(job.id)).toEqual([request!.template]);

    expect((await a.ui('/ui/api/access', { action: 'min-trust', operation: 'write', asset: ACCOUNT, level: 'owner' }, { token })).status).toBe(200);
    expect(a.user().sandboxRequests.runnable(job.id)).toEqual([]);
  });
});
