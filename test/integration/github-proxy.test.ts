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
//   Scenario: a job asks the hopper, not GitHub (issue #1074: repo queries)
//     When the job reads its pull request's diff, commits and checks, and its issue's comments, twice
//     Then GitHub is read once for each: the second answer comes from the hopper's repo-query cache (`source: cache`)
//     And a comment the job posts drops what was kept of that issue: the next read of its comments is GitHub's
//   Scenario: a job of another user files an issue, and may do nothing else
//     Then the issue is filed with the hopper's connection, marked; a comment is refused
//     And both are in that job's timeline and in the hopper's own user's log, naming the user and the job
//   Scenario: an issue a job files is a child of the job's issue (issue #729: issue lineage)
//     Given a job running for octo/tools#7
//     When the job files an issue through the hopper
//     Then the issue's text names octo/tools#7 as its parent, and the lineage is on the job's timeline (`job.child_issue_filed`)
//     And with --required the hopper links it as a GitHub sub-issue of octo/tools#7: a required part of it
//     And a link GitHub refuses leaves the issue filed: the job and the timeline say why
//   Scenario: a token that is no job's, or a job no longer at work, is refused
//   Scenario: the script's help says how, and the job's files carry no GitHub token
//   Scenario: a job whose machine cannot reach the hopper fails at its start, saying why and what to do (issue #695)
//     Given a machine where the reach check finds no hopper at the URL the job would be given
//     When a job starts there
//     Then it fails at once: "this machine cannot reach the hopper at <url>", with the action, and no file is kept there
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { PROXY_HELP } from '../../src/github-proxy/index.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { issueIdOf } from '../support/fake-sub-issues.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

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
  return { app, github, root, held: h.held, reach: h.reach };
}

/** A job of the user's own, running in the holder: its id and variables. */
async function running(t: Awaited<ReturnType<typeof start>>, repo = 'octo/tools', userId = ADMIN_ID, number?: number): Promise<{ job: Job; env: Record<string, string> }> {
  const job = await t.app.pull({}, { executor: 'holder', repo, ...(number !== undefined ? { number } : {}) }, userId);
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
    expect(env).toMatchObject({ HOPPER_URL: t.app.url, HOPPER_GH: `/work/.worktrees/@scratch/${job.id}/credentials/hopper/gh`, HOPPER_SKILL: `/work/.worktrees/@scratch/${job.id}/credentials/hopper/skill`, HOPPER_TOKEN_FILE: `/work/.worktrees/@scratch/${job.id}/credentials/hopper/token` });
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
    expect(eventsOf(t.app, ADMIN_ID, 'job.child_issue_filed')).toEqual([]);
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

  it('answers a job\'s repo queries, and asks GitHub once for each while the answer is fresh; a write drops it (issue #1074)', async () => {
    const t = await start();
    const comment = { id: 1, body: 'Looks good.', user: { login: 'someone' }, created_at: '2026-10-13T00:00:00Z', html_url: `${t.github.url}/octo/tools/issues/7#issuecomment-1` };
    t.github.issues.push({ repo: 'octo/tools', number: 7, title: 'Make it faster', body: 'Please.', author: 'someone', labels: ['hopper'], comments: [comment] });
    const issueUrl = `${t.github.url}/octo/tools/issues/7`;
    const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7, key: issueUrl, url: issueUrl });
    const env = await waitFor(async () => t.held.get(job.id)?.env, { what: 'the job to run' });
    expect(json(await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7-faster', '--title', 'Faster', '--body', 'Closes #7']))).toMatchObject({ number: 8 });
    t.github.pullFiles = { 'octo/tools#8': [
      { filename: 'src/queue.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-slow()\n+fast()' },
      { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
    ] };
    t.github.pullCommits = { 'octo/tools#8': [{ sha: 'c1', commit: { message: 'Make the queue faster', author: { name: 'n', date: '2026-10-13T01:00:00Z' } }, author: { login: 'hopper-bot' } }] };
    t.github.commitChecks = { 'octo/tools@sha-8': {
      runs: [{ id: 115, name: 'pr / test', status: 'completed', conclusion: 'failure', html_url: `${t.github.url}/octo/tools/actions/runs/1/job/115` }],
      statuses: [{ context: 'deploy/preview', state: 'pending', target_url: null, description: 'Waiting' }],
    } };
    const ask = async (args: string[]) => {
      const r = await hopperGh(t.root, env, [...args, '--repo', 'octo/tools']);
      expect(r.code).toBe(0);
      return json(r);
    };
    const gets = (path: string) => t.github.requests.filter((r) => r.method === 'GET' && r.path === `/api/v3/repos/octo/tools/${path}`).length;

    const diff = await ask(['pr', 'diff', '8']);
    expect(diff).toMatchObject({ ok: true, op: 'pr.diff', number: 8, url: `${t.github.url}/octo/tools/pull/8`, source: 'github', files: [
      { file: 'src/queue.ts', status: 'modified', additions: 1, deletions: 1 }, { file: 'logo.png', status: 'added', additions: 0, deletions: 0 },
    ] });
    expect(diff.diff).toBe('diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -1 +1 @@\n-slow()\n+fast()\n'
      + 'diff --git a/logo.png b/logo.png\n--- /dev/null\n+++ b/logo.png\n(no patch: binary, or too large for GitHub to show)\n');
    expect(await ask(['pr', 'commits', '8'])).toMatchObject({ source: 'github', commits: [{ sha: 'c1', message: 'Make the queue faster', author: 'hopper-bot', date: '2026-10-13T01:00:00Z' }] });
    expect(await ask(['pr', 'checks', '8'])).toMatchObject({ source: 'github', state: 'open', merged: false, head: 'issue-7-faster', headSha: 'sha-8',
      checks: [{ id: 115, name: 'pr / test', status: 'completed', conclusion: 'failure' }], statuses: [{ context: 'deploy/preview', state: 'pending', description: 'Waiting' }] });
    // The work-item ledger's word on the job's issue, beside GitHub's.
    expect(await ask(['issue', 'comments', '7'])).toMatchObject({ source: 'github', url: `${t.github.url}/octo/tools/issues/7`, ledger: { key: `${t.github.url}/octo/tools/issues/7`, state: 'working' }, comments: [{ id: 1, author: 'someone', body: 'Looks good.', createdAt: '2026-10-13T00:00:00Z' }] });

    for (const args of [['pr', 'diff', '8'], ['pr', 'commits', '8'], ['pr', 'checks', '8'], ['issue', 'comments', '7']]) {
      expect(await ask(args)).toMatchObject({ ok: true, source: 'cache' });
    }
    expect([gets('pulls/8/files'), gets('pulls/8/commits'), gets('commits/sha-8/check-runs'), gets('issues/7/comments')]).toEqual([1, 1, 1, 1]);
    const done = eventsOf(t.app, ADMIN_ID, 'github_proxy.done').filter((e) => e.jobId === job.id && e.data.source !== undefined);
    expect(done.map((e) => e.data.source).reverse()).toEqual(['github', 'github', 'github', 'github', 'cache', 'cache', 'cache', 'cache']);

    await ask(['issue', 'comment', '7', '--body', 'Pushed a fix.']);
    expect(await ask(['issue', 'comments', '7'])).toMatchObject({ source: 'github', comments: [{ body: 'Looks good.' }, { body: 'Pushed a fix.' }] });
    expect(gets('issues/7/comments')).toBe(2);
  });

  it('reads the full log of a failed check for the job; one GitHub refuses says why (issue #993)', async () => {
    const t = await start();
    t.github.jobLogs = new Map<number, string | number>([[115379122001, '2026-10-13T10:00:02.0000000Z Error: the store is closed\n'], [7, 403]]);
    const { job, env } = await running(t);

    const r = await hopperGh(t.root, env, ['check', 'log', '115379122001', '--repo', 'octo/tools']);
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ ok: true, op: 'check.log', repo: 'octo/tools', number: 115379122001, log: '2026-10-13T10:00:02.0000000Z Error: the store is closed\n' });
    expect(t.github.requests.find((x) => x.path === '/api/v3/repos/octo/tools/actions/jobs/115379122001/logs')?.auth).toBe('token test-account-token');
    expect(eventsOf(t.app, ADMIN_ID, 'github_proxy.done')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'check.log', repo: 'octo/tools', number: 115379122001 }) })]);

    const refused = await hopperGh(t.root, env, ['check', 'log', '7', '--repo', 'octo/tools']);
    expect(refused.code).toBe(1);
    expect(String(json(refused).error)).toContain('the hopper\'s GitHub connection may not read Actions logs');
  });

  it('closes the job\'s own issue as completed, and marks its pull request ready for review; another issue is refused (issue #652)', async () => {
    const t = await start();
    t.github.issues.push({ repo: 'octo/tools', number: 7, title: 'Nothing to change', body: 'Check it.', author: 'someone', labels: ['hopper'] });
    t.github.issues.push({ repo: 'octo/tools', number: 9, title: 'Someone else\'s', body: 'x', author: 'someone', labels: [] });
    const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7, url: `${t.github.url}/octo/tools/issues/7` });
    const env = await waitFor(async () => t.held.get(job.id)?.env, { what: 'the job to run' });

    expect((await hopperGh(t.root, env, ['issue', 'close', '9', '--repo', 'octo/tools'])).stdout).toContain('refused: a job closes only its own issue (octo/tools#7)');
    expect(t.github.issues.find((i) => i.number === 9)!.state ?? 'open').toBe('open');
    const closed = await hopperGh(t.root, env, ['issue', 'close', '7', '--repo', 'octo/tools']);
    expect(json(closed)).toMatchObject({ ok: true, op: 'issue.close', number: 7, state: 'closed' });
    expect(t.github.issues.find((i) => i.number === 7)).toMatchObject({ state: 'closed', stateReason: 'completed' });

    const pr = json(await hopperGh(t.root, env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7-x', '--title', 'X', '--body', 'Closes #7']));
    const ready = await hopperGh(t.root, env, ['pr', 'ready', String(pr.number), '--repo', 'octo/tools']);
    expect(json(ready)).toMatchObject({ ok: true, op: 'pr.ready', number: pr.number, draft: false });
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

  it('fails a job whose machine cannot reach the hopper at its start, saying why and what to do; no file is kept there (issue #695)', async () => {
    const t = await start();
    t.reach.unreached = `this machine cannot reach the hopper at ${t.app.url}: Could not resolve host: hopper`;
    const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools' });
    const failed = await t.app.waitForStatus(job.id, 'failed', 10000);
    expect(failed.error).toContain(`this machine cannot reach the hopper at ${t.app.url}: Could not resolve host: hopper`);
    expect(failed.error).toContain('Settings → Artifacts');
    expect(t.reach.asked).toEqual([t.app.url]);
    expect(t.held.has(job.id)).toBe(false);
  });

  it('checks that the machine reaches the hopper at the URL the job is given, before the job runs (issue #695)', async () => {
    const t = await start();
    const { env } = await running(t);
    expect(t.reach.asked).toEqual([env.HOPPER_URL]);
  });
});

describe('issue lineage through the hopper (issue #729)', () => {
  const subIssueLinks = (f: FakeForge) => f.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/sub_issues'));

  async function parented() {
    const t = await start();
    t.github.issues.push({ repo: 'octo/tools', number: 7, title: 'Ship it in parts', body: 'Please.', author: 'owner', labels: ['hopper'] });
    return { t, ...(await running(t, 'octo/tools', ADMIN_ID, 7)) };
  }

  it('an issue a job files is a follow-up of the job\'s issue: its text names the parent, the lineage is on the job\'s timeline, no sub-issue link', async () => {
    const { t, job, env } = await parented();
    const r = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Later', '--body', 'Do it later.']);
    const answer = json(r);
    expect(answer).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', required: false });
    expect(t.github.issues.find((i) => i.number === 8)!.body).toContain('\n---\nFollow-up of octo/tools#7.\nFiled through hopper');
    expect(subIssueLinks(t.github)).toEqual([]);
    expect(eventsOf(t.app, ADMIN_ID, 'job.child_issue_filed')).toEqual([expect.objectContaining({
      jobId: job.id, data: { requestId: answer.requestId, parent: { repo: 'octo/tools', number: 7 }, child: { repo: 'octo/tools', number: 8, url: answer.url }, required: false },
    })]);
  });

  it('--required links it as a GitHub sub-issue of the job\'s issue', async () => {
    const { t, job, env } = await parented();
    const r = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Fix first', '--body', 'Needed.', '--required']);
    const answer = json(r);
    expect(answer).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', required: true, subIssue: true });
    expect(t.github.issues.find((i) => i.number === 8)!.body).toContain('Required child of octo/tools#7: that issue is not done while this one is open.');
    expect(subIssueLinks(t.github)).toEqual([expect.objectContaining({ path: '/api/v3/repos/octo/tools/issues/7/sub_issues', body: { sub_issue_id: issueIdOf('octo/tools', 8) } })]);
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues).toEqual(['octo/tools#8']);
    expect(eventsOf(t.app, ADMIN_ID, 'job.child_issue_filed')).toEqual([expect.objectContaining({
      jobId: job.id, data: expect.objectContaining({ parent: { repo: 'octo/tools', number: 7 }, child: expect.objectContaining({ number: 8 }), required: true, subIssue: true }),
    })]);
  });

  it('a sub-issue link GitHub refuses leaves the issue filed: the job and the timeline say why', async () => {
    const { t, env } = await parented();
    t.github.subIssuesRefused = 422;
    const r = await hopperGh(t.root, env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Fix first', '--body', 'Needed.', '--required']);
    expect(r.code).toBe(0);
    const answer = json(r);
    expect(answer).toMatchObject({ ok: true, number: 8, required: true, subIssue: false, subIssueError: expect.stringContaining('GitHub answered 422') });
    expect(eventsOf(t.app, ADMIN_ID, 'job.child_issue_filed')).toEqual([expect.objectContaining({
      data: expect.objectContaining({ required: true, subIssue: false, subIssueError: expect.stringContaining('GitHub answered 422') }),
    })]);
  });
});
