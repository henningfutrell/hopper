// Issue #694, part 2: a job reports a hopper bug through the hopper, with no GitHub login of its own, by the same code
// path as a person's report. The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts); the job runs the real
// `hopper-gh` script (sh and curl) on a machine double whose credential files are real files.
//
// Feature: Jobs report hopper bugs
//   Scenario: a job's report waits for a person's approval, then is filed through the hopper (issue #2818)
//     Given a job running on this machine, with no GitHub login of its own, and public bug reports on
//     When the job runs `sh "$HOPPER_GH" report bug --title … --body-file …`
//     Then nothing is posted: the job is answered kind approval and the public warning
//     And Your reports shows the report's text, as it would be posted
//     When a person approves it
//     Then an issue is filed on henningfutrell/hopper with the job's user's own GitHub connection
//     And it has the label user-report, no assignee, and says a job filed it
//     And it is the fixed template: its description, then the OS and the hopper's version, with no job id
//   Scenario: a person discards a job's report: it is never posted (issue #2818)
//   Scenario: with public bug reports off (the default), a job's report is refused, with the warning (issue #2818)
//   Scenario: a job's report keeps nothing of its private work (issue #2812) or of its identifiers (issue #2818)
//     Given a job of the repository octo/tools, which the hopper's repository is not
//     When the job's report names that repository, its issue, a branch it pushed, its paths, a commit, a link, an
//       email address and a host name
//     Then the report names none of them, the hopper's own paths and issues stay
//     And the job's answer and its report's row list what was removed, by kind
//   Scenario: a job's report to add to an open report is a comment there, once approved
//   Scenario: a report sent again with its key, as hopper-gh sends it when no answer came, is kept once (issue #2813)
//   Scenario: a job files at most three reports a day
//     Then the fourth is refused with the reason, and nothing reaches GitHub
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
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

const REPO = 'henningfutrell/hopper';

async function start(o: { publicReports?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'reporter');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-report-machine-'));
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
  connectGitHub(app, ['octo/tools'], { login: 'reporter' });
  if (o.publicReports !== false) app.user(ADMIN_ID).store.settings.setPublicBugReports(true);
  const token = await app.login();
  return { app, github, root, held: h.held, token };
}

async function running(t: Awaited<ReturnType<typeof start>>): Promise<{ job: Job; env: Record<string, string> }> {
  const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools' });
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { job, env };
}

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;
const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const reports = (t: Awaited<ReturnType<typeof start>>) => t.github.issues.filter((i) => i.repo === REPO);

const WARNING = 'This report will be posted publicly on GitHub. Do not include names, emails, customer or company details, repository or host names, links, ids or file paths.';

type Started = Awaited<ReturnType<typeof start>>;
const ui = <T>(t: Started, path: string, body: unknown) => t.app.ui<T>(path, body, { token: t.token });
const yourReports = async (t: Started) => (await t.app.api<{ reports: { id: string; state: string; title: string; body?: string; removed?: string[] }[]; publicReports: boolean }>('GET', '/api/bug-reports', undefined, { 'x-hopper-session': t.token })).body;

describe('A job reports a hopper bug (issue #694)', () => {
  it('waits for a person\'s approval; approved, it is filed with its user\'s own connection: the fixed template, labelled user-report, masked, marked as the job\'s (issue #2818)', async () => {
    const t = await start();
    const { job, env } = await running(t);
    const bodyFile = join(t.root, 'report.md');
    writeFileSync(bodyFile, 'hopper-gh pr view answered 500 from 10.20.30.40.\n');

    const r = await hopperGh(t.root, env, ['report', 'bug', '--title', 'The pull request view answers 500', '--body-file', bodyFile]);
    expect(r).toMatchObject({ code: 0 });
    const answer = json(r);
    expect(answer).toMatchObject({ ok: true, op: 'report.bug', repo: REPO, kind: 'approval', id: expect.any(String), warning: WARNING });
    expect(reports(t)).toHaveLength(0);
    const waiting = (await yourReports(t)).reports;
    expect(waiting).toEqual([expect.objectContaining({ id: answer.id, state: 'approval', title: 'The pull request view answers 500' })]);
    expect(waiting[0]!.body).toMatch(/^### Description\n\nhopper-gh pr view answered 500 from \[IP address, masked\]\.\n\n### System\n\n- OS: [^\n]+\n- Hopper version: \S+\n\n---\nFiled by a job with Report a bug in a hopper\.$/);

    const approved = await ui<{ kind: string; number: number }>(t, '/ui/api/bug-reports/approve', { id: answer.id });
    expect(approved.body).toMatchObject({ kind: 'filed', number: 1 });
    const [issue] = reports(t);
    expect(issue).toMatchObject({ title: 'The pull request view answers 500', author: 'reporter', labels: ['user-report'], assignees: [] });
    expect(issue!.body.startsWith(waiting[0]!.body!)).toBe(true);
    expect(issue!.body).not.toContain(job.id);
    const create = t.github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${REPO}/issues`))!;
    expect(create.auth).toContain('test-account-token');
    expect(eventsOf(t.app, 'bug_report.filed')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ repo: REPO, kind: 'issue', number: 1, fromJob: true }) })]);
    expect((await yourReports(t)).reports[0]).not.toHaveProperty('body');
    expect((await ui(t, '/ui/api/bug-reports/approve', { id: answer.id })).status).toBe(409);
  });

  it('never posts a report a person discards (issue #2818)', async () => {
    const t = await start();
    const { env } = await running(t);
    const answer = json(await hopperGh(t.root, env, ['report', 'bug', '--title', 'The board hangs', '--body', 'It hangs.']));
    expect((await ui(t, '/ui/api/bug-reports/discard', { id: answer.id })).body).toEqual({ ok: true });
    expect((await yourReports(t)).reports).toEqual([]);
    expect((await ui(t, '/ui/api/bug-reports/approve', { id: answer.id })).status).toBe(404);
    expect(reports(t)).toHaveLength(0);
  });

  it('refuses a job\'s report while public bug reports are off, the default, with the warning (issue #2818)', async () => {
    const t = await start({ publicReports: false });
    const { env } = await running(t);
    const r = await hopperGh(t.root, env, ['report', 'bug', '--title', 'The board hangs', '--body', 'It hangs.']);
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({ error: expect.stringContaining('public bug reports are off'), warning: WARNING });
    expect(t.app.user(ADMIN_ID).store.bugReports.list()).toEqual([]);
    expect((await yourReports(t)).publicReports).toBe(false);
  });

  it('removes the job\'s private work and its identifiers before it keeps the report, and says what it removed (issues #2812, #2818)', async () => {
    const t = await start();
    const { job, env } = await running(t);
    t.app.user(ADMIN_ID).store.events.append({ type: 'github_proxy.done', jobId: job.id, data: { requestId: 'push-1', as: 'reporter', op: 'git.push', repo: 'octo/tools', refs: ['refs/heads/fix-cache-bust'] } });
    const bodyFile = join(t.root, 'report.md');
    writeFileSync(bodyFile, [
      'Working on octo/tools#42 on branch fix-cache-bust, the push of 5f3e9a1c2b to deploy/values.yaml went through,',
      'but https://github.com/octo/tools/actions/runs/18234567890 never showed in hopper-gh pr status.',
      'Mail ops@octo.example or reach db01.octo.internal. See src/github-proxy/pr-status.ts and henningfutrell/hopper#1591.',
    ].join('\n'));

    const r = await hopperGh(t.root, env, ['report', 'bug', '--title', 'pr status misses a run of octo/tools', '--body-file', bodyFile]);
    expect(r).toMatchObject({ code: 0 });
    expect(json(r)).toMatchObject({ ok: true, kind: 'approval', removed: expect.arrayContaining(['repository', 'branch name', 'commit id', 'file path', 'link', 'email address', 'host name']) });

    const [kept] = (await yourReports(t)).reports;
    for (const leak of ['octo', 'tools', '#42', 'fix-cache-bust', '5f3e9a1c2b', 'deploy/values.yaml', '18234567890', 'db01']) {
      expect(kept!.title + kept!.body).not.toContain(leak);
    }
    expect(kept!.title).toBe('pr status misses a run of [a repository]');
    expect(kept!.body).toContain('See src/github-proxy/pr-status.ts and henningfutrell/hopper#1591.');
    expect(kept).toMatchObject({ removed: expect.arrayContaining(['repository', 'link', 'email address', 'host name']) });
  });

  it('adds a job\'s report to the open report it names, once approved', async () => {
    const t = await start();
    t.github.issues.push({ repo: REPO, number: 5, title: 'Pull request view answers 500', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    const { env } = await running(t);
    const answer = json(await hopperGh(t.root, env, ['report', 'bug', '--title', 'The pull request view answers 500', '--body', 'It answered 500.', '--comment-on', '5']));
    expect(answer).toMatchObject({ ok: true, kind: 'approval' });
    expect((await ui(t, '/ui/api/bug-reports/approve', { id: answer.id })).body).toMatchObject({ kind: 'commented', number: 5 });
    expect(String(t.github.issues.find((i) => i.number === 5)!.comments![0]!.body)).toContain('It answered 500.');
    expect(reports(t)).toHaveLength(1);
  });

  it('keeps a report sent again with its key once, and answers the first (issue #2813)', async () => {
    const t = await start();
    const { env } = await running(t);
    const args = ['report', 'bug', '--title', 'The pull request view answers 500', '--body', 'It answered 500.', '--key', 'job-report-0001'];
    const first = json(await hopperGh(t.root, env, args));
    expect(first).toMatchObject({ ok: true, kind: 'approval' });
    expect(json(await hopperGh(t.root, env, args))).toMatchObject({ ok: true, kind: 'approval', id: first.id });
    expect((await yourReports(t)).reports).toHaveLength(1);
    expect((await ui(t, '/ui/api/bug-reports/approve', { id: first.id })).body).toMatchObject({ kind: 'filed', number: 1 });
    expect(json(await hopperGh(t.root, env, args))).toMatchObject({ ok: true, kind: 'filed', number: 1 });
    expect(reports(t)).toHaveLength(1);
  });

  it('refuses a fourth report from one job in a day, saying why; nothing reaches GitHub', async () => {
    const t = await start();
    const { job, env } = await running(t);
    for (const n of [1, 2, 3]) {
      expect(json(await hopperGh(t.root, env, ['report', 'bug', '--title', `Problem ${'abcdefghij'[n]}${n} alpha`, '--body', 'x']))).toMatchObject({ ok: true });
    }
    const over = await hopperGh(t.root, env, ['report', 'bug', '--title', 'One more', '--body', 'x']);
    expect(over.code).toBe(1);
    expect(json(over).error).toBe('refused: this job asked for report.bug 3 times in the last day, its limit');
    expect(t.app.user(ADMIN_ID).store.bugReports.list()).toHaveLength(3);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'report.bug' }) })]);
  });

  it('refuses a report with no title or a long description, and lists report bug in the help with the warning', async () => {
    const t = await start();
    const { env } = await running(t);
    const r = await hopperGh(t.root, env, ['report', 'bug', '--body', 'x']);
    expect(r.code).toBe(1);
    expect(String(json(r).error)).toMatch(/^refused: not a request the hopper takes \(title:/);
    const long = await hopperGh(t.root, env, ['report', 'bug', '--title', 'Long', '--body', 'x'.repeat(2001)]);
    expect(long.code).toBe(1);
    const help = (await hopperGh(t.root, env, ['help'])).stdout;
    expect(help).toContain('sh "$HOPPER_GH" report bug --title TITLE');
    expect(help).toContain(WARNING);
  });
});
