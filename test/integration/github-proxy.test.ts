// Issue #563: a running job asks the hopper for a GitHub operation, and the hopper does it with its own GitHub
// connection — the job's machine holds no GitHub login. The daemon, store and HTTP edge are real; GitHub is a
// fake on loopback (test/support/fake-forges.ts); the job's machine is a double at the MachineShell port whose
// credential files are real files, and the job runs the real `hopper-gh` script (sh and curl) against the hopper.
//
// Feature: GitHub through the hopper
//   Scenario: a job files an issue through the hopper
//     Given a hopper whose GitHub is connected, working on octo/tools
//     And a job running on this machine, with no GitHub login of its own
//     When the job runs `sh "$HOPPER_GH" issue create --repo octo/tools --title … --body-file …`
//     Then the issue is filed on GitHub with the hopper's connection, and the job is answered its url
//     And the issue carries no labels and no assignees, and says the hopper filed it for that job
//     And it is on the job's timeline (`github_proxy.done`), and it never becomes a job
//   Scenario: a job asks for a repository the hopper does not work on
//     Then it is refused with the reason, nothing reaches GitHub, and the refusal is on its timeline
//   Scenario: the hopper's own job comments, reads, and opens a pull request from its branch on its own repository
//   Scenario: a pull request on another repository than the job's own is refused
//   Scenario: a job of another user files an issue, and may do nothing else
//     Then the issue is filed with the hopper's connection, marked; a comment is refused
//     And both are in that job's timeline and in the hopper's own user's log, naming the user and the job
//   Scenario: a token that is no job's, or a job no longer at work, is refused
//   Scenario: the script's help says how, and the job's files carry no GitHub token
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor, MachineShell } from '../../src/domain/ports.ts';
import type { DiscoveryFacts, DomainEvent, Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { PROXY_HELP } from '../../src/github-proxy/index.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const NOTHING: DiscoveryFacts = { path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } };

/** A running job of the holder: the variables it runs with, and what ends it. */
interface Held { env: Record<string, string>; end(): void }

/**
 * An executor whose jobs hold their lane until ended, keeping their credential files as real files under `root`
 * (the machine's disk, as the MachineShell port writes them).
 */
function holder(root: string) {
  const held = new Map<string, Held>();
  const shell: MachineShell = {
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async keepCredential(_jobId, dir, file, content) {
      const path = join(root, dir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    async discover() { return NOTHING; },
  };
  const executor: Executor = {
    name: 'holder', idempotent: false, validate: () => null, machineShell: () => shell,
    async run(ctx) {
      const env = { ...(await ctx.credentials?.(`/work/.hopper-scratch/${ctx.job.id}`)) };
      await new Promise<void>((end) => held.set(ctx.job.id, { env, end }));
      return { kind: 'finished', result: 'ended' };
    },
    resume: async () => ({ kind: 'failed', error: 'not resumed' }),
  };
  return { executor, held };
}

interface Run { code: number; stdout: string; stderr: string }

/** The job runs the script it was given, on its machine: its variables, its files under `root`. */
function hopperGh(root: string, env: Record<string, string>, args: string[]): Promise<Run> {
  const onDisk = (v: string | undefined) => (v === undefined ? undefined : join(root, v));
  return new Promise((resolve) => {
    execFile('sh', [onDisk(env.HOPPER_GH)!, ...args], {
      env: { PATH: process.env.PATH, HOPPER_URL: env.HOPPER_URL, HOPPER_TOKEN_FILE: onDisk(env.HOPPER_TOKEN_FILE) } as NodeJS.ProcessEnv,
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-proxy-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools', 'octo/site']);
  return { app, github, root, held: h.held };
}

/** A job of the user's own, running in the holder: its id and variables. */
async function running(t: Awaited<ReturnType<typeof start>>, repo = 'octo/tools', userId = ADMIN_ID): Promise<{ job: Job; env: Record<string, string> }> {
  const job = await t.app.pull({}, { executor: 'holder', repo }, userId);
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { job, env };
}

const eventsOf = (a: TestApp, userId: string, type: string): DomainEvent[] =>
  a.user(userId).store.events.recent(1000).filter((e) => e.type === type);

const created = (f: FakeForge) => f.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'));

describe('GitHub through the hopper (issue #563)', () => {
  it('files an issue for a job with the hopper\'s GitHub connection: unlabelled, unassigned, marked, on the job\'s timeline, never a job', async () => {
    const t = await start();
    const { job, env } = await running(t);
    expect(env).toMatchObject({ HOPPER_URL: t.app.url, HOPPER_GH: `/work/.hopper-scratch/${job.id}/credentials/hopper/gh`, HOPPER_SKILL: `/work/.hopper-scratch/${job.id}/credentials/hopper/skill`, HOPPER_TOKEN_FILE: `/work/.hopper-scratch/${job.id}/credentials/hopper/token` });
    const bodyFile = join(t.root, 'body.md');
    writeFileSync(bodyFile, 'The queue view drops a job\'s "priority" when it is 0.\n');

    const r = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Priority 0 is dropped', '--body-file', bodyFile]);
    expect(r).toMatchObject({ code: 0 });
    const answer = json(r);
    expect(answer).toMatchObject({ ok: true, op: 'issue.create', repo: 'octo/tools', number: 1, url: `${t.github.url}/octo/tools/issues/1` });

    const [sent] = created(t.github);
    expect(sent!.auth).toBe('token test-account-token');
    expect(sent!.body).toEqual({ title: 'Priority 0 is dropped', body: expect.stringContaining('The queue view drops a job\'s "priority" when it is 0.') });
    expect(String(sent!.body.body)).toMatch(new RegExp(`Filed through hopper for job \`${job.id}\` \\(request \`${String(answer.requestId)}\`\\)\\. It is not a job: it waits for a person to triage it\\.$`));
    expect(t.github.issues[0]).toMatchObject({ labels: [], assignees: [] });

    const [done] = eventsOf(t.app, ADMIN_ID, 'github_proxy.done');
    expect(done).toMatchObject({ jobId: job.id, data: { requestId: answer.requestId, op: 'issue.create', repo: 'octo/tools', number: 1, url: answer.url, own: true, machine: 'local' } });
    await t.app.sync();
    expect((await t.app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.map((j) => j.id)).toEqual([job.id]);
  });

  it('refuses a repository the hopper does not work on, saying why; nothing reaches GitHub', async () => {
    const t = await start();
    const { job, env } = await running(t);
    const r = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'someone/else', '--title', 'x', '--body', 'y']);
    expect(r.code).toBe(1);
    expect(json(r).error).toBe('refused: someone/else is not one of the repositories the hopper works on, so it does nothing there for a job');
    expect(created(t.github)).toEqual([]);
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.refused')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'issue.create', repo: 'someone/else', own: true }) })]);
  });

  it('comments, reads an issue, opens a pull request from the job\'s branch on its own repository, and reads it', async () => {
    const t = await start();
    t.github.issues.push({ repo: 'octo/tools', number: 7, title: 'Make it faster', body: 'Please.', author: 'someone', labels: ['hopper'] });
    const { env } = await running(t);

    const comment = await hopperGh(t.root, env, ['issue', 'comment', '7', '--repo', 'octo/tools', '--body', 'Found the cause.']);
    expect(json(comment)).toMatchObject({ ok: true, op: 'issue.comment', number: 7, url: expect.stringContaining('/octo/tools/issues/7#issuecomment-') });
    expect(t.github.requests.find((r) => r.method === 'POST' && r.path.endsWith('/issues/7/comments'))?.body).toEqual({ body: 'Found the cause.' });

    const view = await hopperGh(t.root, env, ['issue', 'view', '7', '--repo', 'octo/tools']);
    expect(json(view)).toMatchObject({ ok: true, number: 7, title: 'Make it faster', state: 'open', author: 'someone', labels: ['hopper'], body: 'Please.' });

    const pr = await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7-faster', '--title', 'Faster', '--body', 'Closes #7']);
    expect(json(pr)).toMatchObject({ ok: true, op: 'pr.create', number: 8, head: 'issue-7-faster', base: 'dev', url: `${t.github.url}/octo/tools/pull/8` });
    const prView = await hopperGh(t.root, env, ['pr', 'view', '8', '--repo', 'octo/tools']);
    expect(json(prView)).toMatchObject({ number: 8, head: 'issue-7-faster', base: 'dev', merged: false, body: 'Closes #7' });

    const failed = await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'dev', '--base', 'dev', '--title', 'Nothing', '--body', 'x']);
    expect(failed.code).toBe(1);
    expect(json(failed)).toMatchObject({ error: 'GitHub answered 422 to pr.create on octo/tools: Validation Failed (No commits between dev and dev)', githubStatus: 422 });
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.failed')).toHaveLength(1);
  });

  it('opens a pull request only on the job\'s own repository', async () => {
    const t = await start();
    const { env } = await running(t, 'octo/tools');
    const r = await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/site', '--head', 'x', '--title', 'x', '--body', 'x']);
    expect(json(r).error).toBe('refused: a job opens a pull request only on its own repository (octo/tools)');
    expect(t.github.requests.filter((q) => q.path.endsWith('/pulls'))).toEqual([]);
  });

  it('files an issue for another user\'s job with the hopper\'s connection, and does nothing else for it; the hopper\'s own user sees both', async () => {
    const t = await start();
    const guest = await t.app.addUser('guest');
    await t.app.addThisMachine(guest.id);
    const { job, env } = await running(t, 'guest/own', guest.id);

    const filed = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Found a problem', '--body', 'Details.']);
    expect(json(filed)).toMatchObject({ ok: true, number: 1 });
    expect(created(t.github)[0]!.auth).toBe('token test-account-token');
    expect(String(created(t.github)[0]!.body.body)).toContain(`Filed through hopper for job \`${job.id}\``);
    expect(t.github.issues[0]).toMatchObject({ labels: [], assignees: [] });

    const comment = await hopperGh(t.root, env, ['issue', 'comment', '1', '--repo', 'octo/tools', '--body', 'more']);
    expect(comment.code).toBe(1);
    expect(json(comment).error).toBe('refused: a job of another user may only file an issue through the hopper (issue.create), not issue.comment');

    expect(eventsOf(t.app, guest.id, 'github_proxy.done')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ own: false }) })]);
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.done')).toEqual([expect.objectContaining({ data: expect.objectContaining({ own: false, forUser: guest.id, job: job.id, url: expect.any(String) }) })]);
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.refused')).toEqual([expect.objectContaining({ data: expect.objectContaining({ forUser: guest.id, op: 'issue.comment' }) })]);
  });

  it('refuses a token that is no job\'s, and a job no longer at work', async () => {
    const t = await start();
    const { job, env } = await running(t);
    const token = readFileSync(join(t.root, env.HOPPER_TOKEN_FILE!), 'utf8');
    const post = (authorization: string) => fetch(`${t.app.url}/job/github`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'issue.view', repo: 'octo/tools', number: 1 }),
    });
    expect((await post(`Bearer ${token.slice(0, -2)}xx`)).status).toBe(401);
    expect((await post('Bearer nothing')).status).toBe(401);
    t.held.get(job.id)!.end();
    await t.app.waitForStatus(job.id, 'finished');
    const ended = await post(`Bearer ${token}`);
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: `refused: job ${job.id} is finished, not at work: only a running job asks the hopper` });
  });

  it('gives the job the script and its token, never a GitHub token; the help says how', async () => {
    const t = await start();
    const { env } = await running(t);
    expect(JSON.stringify(env)).not.toContain('test-account-token');
    expect(readFileSync(join(t.root, env.HOPPER_TOKEN_FILE!), 'utf8')).not.toContain('test-account-token');
    const help = await hopperGh(t.root, env, ['help']);
    expect(help).toMatchObject({ code: 0 });
    expect(help.stdout.trim()).toBe(PROXY_HELP);
    expect((await hopperGh(t.root, env, ['auth', 'login'])).code).toBe(2);
  });
});
