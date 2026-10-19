// The secret canary check (issue #1957), part 2: the paths of a job that moves. Through the real daemon over the fake
// herdr (as checkpoint.test.ts), a hopper is given distinct random canaries as the master key, a connected account's
// tokens (GitHub's own forms, so the masks that know them are tested) and a webhook's signing secret; the job's proxy
// token is the credential the hopper mints. A running job asks the hopper to file an issue through its user's GitHub
// connection; its machine's checkpoint carries the job's proxy token in its agent session and a GitHub token in its work
// not pushed; it is parked, resumes elsewhere from that checkpoint, and fails, saying the token; the failure is assessed.
// Then the whole database, the work dir, the console, the event log, an SSE replay, the webhook bodies, the fake
// GitHub's requests (but the connection's own `authorization`), the checkpoint's parts as the hopper serves them, and
// what the job's machine was told are scanned: no canary is anywhere.
//
// Feature: a secret appears only where it is kept
//   Scenario: after GitHub through the hopper, a checkpoint, a resume elsewhere and an assessed failure, no canary is in any place the scan reads
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckpointCapture, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { startReceiver } from '../support/receiver.ts';
import { canary, databasePlaces, filePlaces, report, scan, type Place } from '../support/secret-canary.ts';
import { openSse } from '../support/sse.ts';
import { putAccount } from '../support/system-secrets.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const cleanups: (() => unknown)[] = [];
let logged: string[] = [];
beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };
const BASE = 'b'.repeat(40);
/** A GitHub token of `prefix` (`ghu_`, `ghr_`), random: a canary in the form GitHub gives it. */
const githubCanary = (prefix: string): string => `${prefix}${canary('x').replace(/[^A-Za-z0-9]/g, '')}`;
/** A place of captured text. */
const captured = (name: string, value: unknown): Place => ({ name, text: typeof value === 'string' ? value : JSON.stringify(value) });

describe('the secret canary check, a job that moves (issue #1957)', () => {
  it('after GitHub through the hopper, a checkpoint, a resume elsewhere and an assessed failure, no canary is in any place the scan reads', async () => {
    const access = githubCanary('ghu_');
    const refresh = githubCanary('ghr_');
    const webhook = canary('webhook');
    const canaries: Record<string, string> = { 'master key': KEY, 'account access token': access, 'account refresh token': refresh, 'webhook signing secret': webhook };

    const github = await createFakeGitHub({ clientId: 'gh-client-id' });
    cleanups.push(() => github.close());
    github.tokens.set(access, 'owner');
    const rx = await startReceiver();
    cleanups.push(() => rx.close());
    const capture: CheckpointCapture = { none: 'not yet' };
    const failed = { output: ['● The push was refused.', `  HOPPER_FAILED the push was refused with ${access}`] };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, WORKING, failed], repositories: [`${homedir()}/shed`], checkpoint: capture });
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a: TestApp = await startTestApp({
      dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
      plugins: { executors: EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }] },
      seams: { herdr, levels: [] },
      env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    });
    cleanups.push(() => a.stop());
    const token = await a.login();
    const { store } = a.user();
    putAccount(store, {
      provider: 'github', account: 'owner', subject: '1', connectedAt: '2026-10-07T00:00:00.000Z', grantedBy: 'device',
      accessToken: access, refreshToken: refresh, expiresAt: '2099-01-01T00:00:00.000Z',
    }, KEY);
    store.settings.setJobRepositories('github', ['octo/tools']);
    expect((await a.ui('/ui/api/webhooks', { action: 'add', name: 'canary', url: rx.url, events: ['*'], secret: webhook }, { token })).status).toBe(200);

    // The job runs, with its proxy token: the credential the hopper mints for it.
    const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} });
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    const proxy = proxyToken(store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
    canaries['proxy token'] = proxy;
    const asJob = (path: string, init: RequestInit = {}) => fetch(`${a.url}${path}`, { ...init, headers: { authorization: `Bearer ${proxy}`, ...init.headers } });

    // GitHub through the hopper: the job files an issue with its user's connection.
    const filed = await asJob('/job/github', { method: 'POST', body: new URLSearchParams({ op: 'issue.create', repo: 'octo/tools', title: 'Sand the shed', body: 'The shed needs sanding.', key: 'canary-issue-1' }) });
    expect(filed.status, await filed.clone().text()).toBe(200);

    // The checkpoint: the agent read its own token file, and the work not pushed holds a GitHub token.
    const taken = capture as { none?: string; taken?: unknown };
    delete taken.none;
    taken.taken = {
      branch: 'hopper/shed', base: BASE, head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'],
      patch: gzipSync(`diff --git a/shed.txt b/shed.txt\n+++ b/shed.txt\n+colour=blue\n+GH_TOKEN=${access}\n`),
      session: gzipSync(`${JSON.stringify({ type: 'user', message: `my token is ${proxy}` })}\n`),
    };
    expect((await a.ui<Job>(`/ui/api/jobs/${job.id}/park`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(async () => (await a.job(job.id)).checkpoint !== undefined, { what: 'the checkpoint at the park' });

    // It resumes elsewhere: the job reads its checkpoint from the hopper, then fails, saying the token.
    expect((await a.ui<Job>(`/ui/api/jobs/${job.id}/requeue`, { elsewhere: true }, { token })).status).toBe(200);
    await waitFor(() => herdr.prompts.length > 1, { what: 'the resumed session told it moved' });
    const served = { patch: await (await asJob('/job/checkpoint/patch')).text(), session: await (await asJob('/job/checkpoint/session')).text() };
    expect(served.patch).toContain('+colour=blue');
    herdr.wake(herdr.prompts[1]!.name);
    await a.waitForStatus(job.id, 'failed', 8000);
    await waitFor(async () => (await a.job(job.id)).assessment, { what: 'the failure assessed' });
    await waitFor(() => rx.received.some((r) => r.body.includes('job.assessed')), { what: 'the webhook of the assessment' });

    const events = await a.events('limit=1000');
    const sse = await openSse(`${a.url}/api/events/stream`, { 'last-event-id': '0' });
    await waitFor(() => sse.messages.length >= events.length, { what: 'the SSE replay' });
    sse.close();
    const places: Place[] = [
      ...databasePlaces(databaseUrlFor(a.dbPath)),
      ...filePlaces('work dir', a.dataDir),
      captured('console', logged.join('\n')),
      captured('event log', events),
      captured('SSE replay', sse.messages),
      captured('webhook deliveries', rx.received),
      captured('GitHub requests', github.requests.map(({ auth: _connection, ...r }) => r)),
      captured('checkpoint as served', served),
      captured('prompts to the machine', herdr.prompts),
      captured('agent starts on the machine', herdr.agentStarts),
      captured('restores on the machine', herdr.restores),
    ];
    expect(report(scan(canaries, places))).toBe('');
    // The controls: GitHub was asked with the connection, the checkpoint was kept and restored, the failure was assessed.
    expect(github.requests.some((r) => r.auth.includes(access) && r.method === 'POST' && r.path.endsWith('/issues'))).toBe(true);
    expect(herdr.restores).toHaveLength(1);
    expect(store.checkpoints.get(job.id)).toBeDefined();
    expect((await a.job(job.id)).error).toContain('the push was refused');
    // The job's machine holds its proxy token, and no other canary.
    const { 'proxy token': _minted, ...others } = canaries;
    expect(report(scan(others, [captured('credentials on the machine', herdr.credentials)]))).toBe('');
  }, 60_000);
});
