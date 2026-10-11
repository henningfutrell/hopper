// Issue #694, part 2: a job reports a hopper bug through the hopper, with no GitHub login of its own, by the same code
// path as a person's report; and the duplicate search finds a report of the same error by its failure signature. The
// daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts); the job runs the real
// `hopper-gh` script (sh and curl) on a machine double whose credential files are real files.
//
// Feature: Jobs report hopper bugs
//   Scenario: a job files a bug report through the hopper
//     Given a job running on this machine, with no GitHub login of its own
//     When the job runs `sh "$HOPPER_GH" report bug --title … --body-file …`
//     Then an issue is filed on henningfutrell/hopper with the job's user's own GitHub connection
//     And it has the label user-report, no assignee, and says a job filed it
//     And its text is masked, and it carries the job's context
//     And the job is answered the issue's link, and bug_report.filed marks it as the job's
//   Scenario: a similar open report is offered to the job first
//     Then nothing is filed; the job reads the similar reports, and adds its report to one or files a new one
//   Scenario: a job files at most three reports a day
//     Then the fourth is refused with the reason, and nothing reaches GitHub
//   Scenario: a report on a failed job finds an open report of the same error by its signature
//     Given an open user-report issue whose body names the failure's signature, with an unlike title
//     When the person sends a report on the failed job with its context
//     Then that issue is offered as similar
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
    expect(issue!.body).toContain(`- Job: ${job.id} (running)`);
    expect(issue!.body).toContain(`Filed by a job (${job.id}) with Report a bug in a hopper.`);
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

describe('The duplicate search by error signature (issue #694)', () => {
  it('offers an open report whose body names the failed job\'s signature, whatever its title', async () => {
    const github = await createFakeGitHub({ clientId: 'gh-client-id' });
    cleanups.push(() => github.close());
    github.tokens.set('test-account-token', 'reporter');
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const app = await startTestApp({ dbPath: db.dbPath, env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' } });
    apps.push(app);
    connectGitHub(app, ['octo/tools'], { login: 'reporter' });
    const token = await app.login();
    const job = await app.pull({ op: 'fail', ms: 0, message: 'the lane lock was lost' });
    await app.waitForStatus(job.id, 'failed');
    const record = await waitFor(async () => app.user().store.failures.forJob(job.id), { what: 'the failure record' });
    github.issues.push({ repo: REPO, number: 3, title: 'Something odd', body: `- Signature: ${record.signature}`, author: 'someone', labels: ['user-report'], assignees: [] });

    const { context } = (await app.ui<{ context: string }>('/ui/api/bug-reports/context', { jobId: job.id }, { token })).body;
    expect(context).toContain(`- Signature: ${record.signature}`);
    const r = await app.ui<{ kind: string; similar: { number: number }[] }>('/ui/api/bug-reports', { title: 'Jobs stop at random', happened: 'It stopped.', context, jobId: job.id }, { token });
    expect(r.body).toMatchObject({ kind: 'similar', similar: [{ number: 3 }] });

    const without = await app.ui<{ kind: string }>('/ui/api/bug-reports', { title: 'Jobs stop at random', happened: 'It stopped.', context: '- Install: host', jobId: job.id }, { token });
    expect(without.body.kind).toBe('filed');
  });
});
