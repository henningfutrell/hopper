// Issue #694, part 2: a job reports a hopper bug through the hopper, with no GitHub login of its own, by the same code
// path as a person's report. The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts); the job runs the real
// `hopper-gh` script (sh and curl) on a machine double whose credential files are real files.
//
// Feature: Jobs report hopper bugs
//   Scenario: a job files a bug report through the hopper
//     Given a job running on this machine, with no GitHub login of its own
//     When the job runs `sh "$HOPPER_GH" report bug --title … --body-file …`
//     Then an issue is filed on henningfutrell/hopper with the job's user's own GitHub connection
//     And it has the label user-report, no assignee, and says a job filed it
//     And its text is masked, and its context is the System line only, with no job id (issue #2478)
//     And the job is answered the issue's link, and bug_report.filed marks it as the job's
//   Scenario: a similar open report is offered to the job first
//     Then nothing is filed; the job reads the similar reports, and adds its report to one or files a new one
//   Scenario: a report sent again with its key, as hopper-gh sends it when no answer came, is filed once (issue #2813)
//     Then the job is answered the first issue, and one issue exists
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

async function start() {
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
  return { app, github, root, held: h.held };
}

async function running(t: Awaited<ReturnType<typeof start>>): Promise<{ job: Job; env: Record<string, string> }> {
  const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools' });
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { job, env };
}

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;
const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const reports = (t: Awaited<ReturnType<typeof start>>) => t.github.issues.filter((i) => i.repo === REPO);

describe('A job reports a hopper bug (issue #694)', () => {
  it('files it on the hopper\'s repository with its user\'s own connection: labelled user-report, masked, marked as the job\'s', async () => {
    const t = await start();
    const { job, env } = await running(t);
    const bodyFile = join(t.root, 'report.md');
    writeFileSync(bodyFile, 'hopper-gh pr view answered 500 from 10.20.30.40.\n');

    const r = await hopperGh(t.root, env, ['report', 'bug', '--title', 'The pull request view answers 500', '--body-file', bodyFile]);
    expect(r).toMatchObject({ code: 0 });
    expect(json(r)).toMatchObject({ ok: true, op: 'report.bug', repo: REPO, kind: 'filed', number: 1, url: `${t.github.url}/${REPO}/issues/1` });

    const [issue] = reports(t);
    expect(issue).toMatchObject({ title: 'The pull request view answers 500', author: 'reporter', labels: ['user-report'], assignees: [] });
    expect(issue!.body).toContain('### What happened\n\nhopper-gh pr view answered 500 from');
    expect(issue!.body).not.toContain('10.20.30.40');
    expect(issue!.body).toMatch(/### Context\n\n- System: [^\n]+\n\n---\n/);
    expect(issue!.body).toContain('Filed by a job with Report a bug in a hopper.');
    expect(issue!.body).not.toContain(job.id);
    const create = t.github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${REPO}/issues`))!;
    expect(create.auth).toContain('test-account-token');
    expect(eventsOf(t.app, 'bug_report.filed')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ repo: REPO, kind: 'issue', number: 1, fromJob: true }) })]);
  });

  it('offers a similar open report first; the job adds its report to it, or files a new one with --force', async () => {
    const t = await start();
    t.github.issues.push({ repo: REPO, number: 5, title: 'Pull request view answers 500', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    const { env } = await running(t);
    const args = ['report', 'bug', '--title', 'The pull request view answers 500', '--body', 'It answered 500.'];

    const similar = await hopperGh(t.root, env, args);
    expect(similar.code).toBe(1);
    expect(json(similar)).toMatchObject({ similar: [{ number: 5, title: 'Pull request view answers 500', url: `${t.github.url}/${REPO}/issues/5` }] });
    expect(String(json(similar).error)).toContain('--comment-on 5');
    expect(reports(t)).toHaveLength(1);

    const comment = await hopperGh(t.root, env, [...args, '--comment-on', '5']);
    expect(json(comment)).toMatchObject({ ok: true, kind: 'commented', number: 5 });
    expect(String(t.github.issues.find((i) => i.number === 5)!.comments![0]!.body)).toContain('It answered 500.');

    const forced = await hopperGh(t.root, env, [...args, '--force']);
    expect(json(forced)).toMatchObject({ ok: true, kind: 'filed', number: 6 });
  });

  it('files a report sent again with its key once, and answers the first issue (issue #2813)', async () => {
    const t = await start();
    const { env } = await running(t);
    const args = ['report', 'bug', '--title', 'The pull request view answers 500', '--body', 'It answered 500.', '--key', 'job-report-0001'];
    const first = await hopperGh(t.root, env, args);
    expect(json(first)).toMatchObject({ ok: true, kind: 'filed', number: 1 });
    const again = await hopperGh(t.root, env, args);
    expect(json(again)).toMatchObject({ ok: true, kind: 'filed', number: 1 });
    expect(reports(t)).toHaveLength(1);
    expect(eventsOf(t.app, 'bug_report.filed')).toHaveLength(1);
  });

  it('refuses a fourth report from one job in a day, saying why; nothing reaches GitHub', async () => {
    const t = await start();
    const { job, env } = await running(t);
    for (const n of [1, 2, 3]) {
      expect(json(await hopperGh(t.root, env, ['report', 'bug', '--title', `Problem ${'abcdefghij'[n]}${n} alpha`, '--body', 'x', '--force']))).toMatchObject({ ok: true });
    }
    const over = await hopperGh(t.root, env, ['report', 'bug', '--title', 'One more', '--body', 'x', '--force']);
    expect(over.code).toBe(1);
    expect(json(over).error).toBe('refused: this job asked for report.bug 3 times in the last day, its limit');
    expect(reports(t)).toHaveLength(3);
    expect(eventsOf(t.app, 'github_proxy.refused')).toEqual([expect.objectContaining({ jobId: job.id, data: expect.objectContaining({ op: 'report.bug' }) })]);
  });

  it('refuses a report with no title, and lists report bug in the help', async () => {
    const t = await start();
    const { env } = await running(t);
    const r = await hopperGh(t.root, env, ['report', 'bug', '--body', 'x']);
    expect(r.code).toBe(1);
    expect(String(json(r).error)).toMatch(/^refused: not a request the hopper takes \(title:/);
    expect((await hopperGh(t.root, env, ['help'])).stdout).toContain('sh "$HOPPER_GH" report bug --title TITLE');
  });
});
