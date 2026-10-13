// Issue #998, through the real composition root and the real HTTP server, the herdr executor over the fake herdr, and
// OpenFGA and the container runtime as doubles at their ports: a job asks the hopper for a sandbox, a person must approve
// its template first, and the job ends its turn with HOPPER_WAITING. When the answer is ready, the hopper ends the job's
// own wait with it, whether the job asked with --wait or not, and the job goes on.
//
// Feature: an answer the hopper gives ends the job's own wait
//   Scenario: a job on its own wait asked for a sandbox without --wait; a person approves the template; the box starts
//     and the hopper ends the job's wait with the box's name
//   Scenario: asked again without --wait, the job's request keeps the one watch it has
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job, TemplateView, VaultView } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const NEEDS = 'write/aws-account/123456789012';
const AWS_WRITE = { operation: 'write', asset: { kind: 'aws-account', name: '123456789012' } } as const;
const WAIT = {
  output: ['● The template waits for a person.', '  HOPPER_WAITING', '  for: approval of the sandbox template'],
  background: { work: '1 shell', polls: 1_000_000 },
};
const DONE = { output: ['● The box runs. Done.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 300, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Read the AWS account', cwd: '/tmp', env: {} };

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(herdr: FakeHerdrClient): Promise<{ a: TestApp; token: string; runtime: FakeContainerRuntime }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const runtime = createFakeContainerRuntime();
  const a = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { executors: EXECUTORS, machines: lanes(1) },
    seams: { herdr, levels: [], authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime },
  });
  apps.push(a);
  return { a, token: await a.login(), runtime };
}

/** The job's credentials dir as the hopper keeps it: its proxy token and `hopper-skill`. */
function credentials(a: TestApp, jobId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-credentials-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, jobId)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return dir;
}

function skill(a: TestApp, creds: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') }, encoding: 'utf8' },
      (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout }));
  });
}

const view = async (a: TestApp, token: string): Promise<VaultView> => (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': token })).body;
const asked = async (a: TestApp, token: string): Promise<TemplateView[]> => (await view(a, token)).templates.filter((t) => t.name.startsWith('asked-'));
const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);

async function waitingJob(a: TestApp): Promise<Job> {
  const job = await a.pull({}, item);
  return a.waitForStatus(job.id, 'waiting_on', 8000);
}

describe('an answer the hopper gives ends the job\'s own wait (issue #998)', () => {
  it('a person approves the template the job waits on: the box starts, and the hopper ends the job\'s wait with its name', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const { a, token, runtime } = await boot(herdr);
    expect((await a.ui('/ui/api/sandbox-approvals', { skipSandboxApproval: true }, { token })).status).toBe(200);
    const job = await waitingJob(a);
    const creds = credentials(a, job.id);

    const first = await skill(a, creds, ['sandbox', '--needs', NEEDS]);
    expect(first.code, first.stdout).toBe(3);
    expect(first.stdout).toContain('the hopper ends this job\'s own wait with it');
    const [t] = await asked(a, token);

    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: t!.name }, { token })).status).toBe(200);
    expect((await a.ui('/ui/api/vault', { action: 'approve-profile', name: t!.name, ...AWS_WRITE }, { token })).status).toBe(200);

    await a.waitForStatus(job.id, 'finished', 8000);
    const [req] = (await view(a, token)).sandboxRequests ?? [];
    expect(req).toMatchObject({ template: t!.name, state: 'running' });
    expect(runtime.boxes.has(req!.container!)).toBe(true);
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain('The hopper ended your wait');
    expect(herdr.prompts[1]!.text).toContain(`sandbox: box ${req!.container!} of template ${t!.name} runs`);
    const ended = (await ofJob(a, job.id)).filter((e) => e.type === 'job.wait_ended');
    expect(ended.map((e) => (e.data as { by: string }).by)).toEqual(['hopper']);
  });

  it('asked again without --wait, the job\'s request keeps the one watch it has', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
    const { a } = await boot(herdr);
    const job = await waitingJob(a);
    const creds = credentials(a, job.id);
    expect((await skill(a, creds, ['sandbox', '--needs', NEEDS])).code).toBe(3);
    expect((await skill(a, creds, ['sandbox', '--needs', NEEDS])).code).toBe(3);
    expect(a.user().jobStream.repo.openWatches(job.id)).toHaveLength(1);
  });
});
