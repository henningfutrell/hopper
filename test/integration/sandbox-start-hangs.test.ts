// Issue #1002, through the real composition root and the real HTTP server, with the container runtime a double whose
// image pull never ends: approving a sandbox run records the approval and answers at once; the box starts after, in
// the background. While its start hangs the UI and the API answer, other requests are decided and other jobs run; at
// its time limit the request fails with the reason, and the job is told.
//
// Feature: a box that does not start holds nothing else
//   Scenario: a person approves a sandbox run whose box never starts
//     Given a job's sandbox request waits for a person
//     And the container runtime's image pull never ends
//     When a person approves the request
//     Then the approval answers within the latency budget (issue #1194)
//     And the health, the queue and the vault's view answer in under 500 ms while the start hangs
//     And another job's request is declined, and another job starts
//     And at the start's time limit the request fails with the reason, an event on the job's timeline
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
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { BUDGET_MS } from '../support/latency.ts';
import { KEY } from '../support/webhooks.ts';

const NEEDS = 'write/aws-account/123456789012';
/** Why the job asks, and what the box will change (issue #1001): a need that changes an asset takes a plan. */
const ASK = ['--why', 'Create the bucket for the report', '--plan', 'aws s3 mb s3://report (undo: aws s3 rb s3://report)'];
const START_MS = 2000;

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function runningJob(a: TestApp): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  const dir = mkdtempSync(join(tmpdir(), 'job-credentials-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return dir;
}

function skill(a: TestApp, creds: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') }, encoding: 'utf8' },
      (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout }));
  });
}

/** The answer's status and how long it took. */
async function timed<T>(call: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; ms: number }> {
  const from = performance.now();
  const r = await call();
  return { ...r, ms: performance.now() - from };
}

describe('a box that does not start holds nothing else (issue #1002)', () => {
  it('a person approves a sandbox run whose box never starts', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const runtime = createFakeContainerRuntime();
    let pulls = 0;
    runtime.pull = () => { pulls++; return new Promise(() => {}); };
    const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(3) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime, sandboxStartMs: START_MS } });
    apps.push(a);
    const token = await a.login();
    const session = { 'x-hopper-session': token };
    const view = async (): Promise<VaultView> => (await a.api<VaultView>('GET', '/api/vault', undefined, session)).body;
    expect((await a.ui('/ui/api/sandbox-approvals', { skipTemplateApproval: true }, { token })).status).toBe(200);

    const first = await runningJob(a), second = await runningJob(a);
    expect((await skill(a, first, ['sandbox', '--needs', NEEDS, ...ASK])).code).toBe(3);
    expect((await skill(a, second, ['sandbox', '--needs', NEEDS, ...ASK])).code).toBe(3);
    const [stuck, other] = (await view()).sandboxRequests!;
    expect(stuck).toMatchObject({ state: 'waiting' });

    const approved = await timed(() => a.ui<VaultView>('/ui/api/sandbox-requests', { action: 'approve', id: stuck!.id }, { token }));
    expect(approved.status).toBe(200);
    expect(approved.ms).toBeLessThan(BUDGET_MS);
    for (let i = 0; i < 50 && pulls === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(pulls).toBe(1);

    // The start hangs: the hopper answers.
    for (const path of ['/api/health', '/api/queue', '/api/vault']) {
      const r = await timed(() => a.api('GET', path, undefined, session));
      expect(r.status, path).toBe(200);
      expect(r.ms, path).toBeLessThan(500);
    }
    const declined = await timed(() => a.ui('/ui/api/sandbox-requests', { action: 'decline', id: other!.id, reason: 'not this one' }, { token }));
    expect(declined.status).toBe(200);
    expect(declined.ms).toBeLessThan(500);
    const job = await a.pull({ op: 'sleep', ms: 60000 });
    await a.waitForStatus(job.id, 'running', 10000);
    expect((await view()).sandboxRequests!.find((r) => r.id === stuck!.id)).toMatchObject({ state: 'starting' });

    // At its time limit, the request fails with the reason, and the job is told.
    let failed: NonNullable<VaultView['sandboxRequests']>[number] | undefined;
    for (let i = 0; i < 100 && !failed; i++) {
      failed = (await view()).sandboxRequests!.find((r) => r.id === stuck!.id && r.state === 'failed');
      if (!failed) await new Promise((r) => setTimeout(r, 50));
    }
    expect(failed).toMatchObject({ reason: 'the box did not start in 2 s' });
    expect((await a.events()).find((e) => e.type === 'vault.sandbox_failed')).toMatchObject({ jobId: stuck!.jobId, data: { request: stuck!.id, reason: 'the box did not start in 2 s' } });
    const told = await skill(a, first, ['sandbox', '--needs', NEEDS, ...ASK]);
    expect(told.code).toBe(1);
    expect(told.stdout).toContain('the box did not start in 2 s');
  });
});
