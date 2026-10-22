// Issue #694: Report a bug. A person reviews the redacted context, and the hopper files the report on the hopper's own
// repository through that person's GitHub connection. The daemon, store and HTTP edge are real; GitHub is a fake on
// loopback (test/support/fake-forges.ts).
//
// Feature: Report a bug
//   Scenario: the form's context is redacted before the person sees it
//     Given a failed job whose error names an IP address and a token
//     When the person asks for the context of a report on that job
//     Then it names the job and its state, and carries neither the address nor the token
//   Scenario: a report is filed as the person, labelled user-report
//     When the person sends a report
//     Then an issue is filed on henningfutrell/hopper with the person's own GitHub token
//     And it has the label user-report, no hopper label and no assignee, so it never starts a job
//     And the answer has its link, and bug_report.filed is in the log
//   Scenario: a similar open report is offered first
//     Given an open user-report issue with a similar title
//     When the person sends a report
//     Then nothing is filed, and the similar report is answered
//     And the person can add a comment to it, or file a new one anyway
//   Scenario: with no GitHub connection the report is kept, with the reason (sent later: bug-reports-later.test.ts)
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'henningfutrell/hopper';

async function start(o: { connected?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'reporter');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (o.connected !== false) connectGitHub(app, ['octo/tools'], { login: 'reporter' });
  const token = await app.login();
  return { app, github, token };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

const REPORT = { title: 'The board hangs when a job fails', happened: 'The board stopped.', expected: 'The board shows the failure.', context: '- System: linux 6.18.2 (x64), Node v24.3.0' };

describe('Report a bug', () => {
  it('answers the context of a report: the System line only, never the version, install type or a job (issue #2478)', async () => {
    const { app, token } = await start();
    const r = await app.ui<{ context: string; repo: string }>('/ui/api/bug-reports/context', {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.repo).toBe(REPO);
    expect(r.body.context).toMatch(/^- System: \S+ \S+ \(\S+\), Node v\d+\.\d+\.\d+$/);
    const job = await app.pull({ op: 'fail', ms: 0, message: 'push failed' });
    await app.waitForStatus(job.id, 'failed');
    expect((await app.ui('/ui/api/bug-reports/context', { jobId: job.id }, { token })).status).toBe(400);
  });

  it('files a report on a failed job whose context is the System line only (issue #2478)', async () => {
    const { app, github, token } = await start();
    const job = await app.pull({ op: 'fail', ms: 0, message: 'push failed' });
    await app.waitForStatus(job.id, 'failed');
    const { context } = (await app.ui<{ context: string }>('/ui/api/bug-reports/context', {}, { token })).body;
    const r = await app.ui<{ kind: string }>('/ui/api/bug-reports', { ...REPORT, context, jobId: job.id, force: true }, { token });
    expect(r.body.kind).toBe('filed');
    const body = github.issues.find((i) => i.repo === REPO)!.body;
    const section = body.split('### Context\n\n')[1]!.split('\n\n---\n')[0]!;
    expect(section).toBe(context);
    expect(section.split('\n')).toEqual([expect.stringMatching(/^- System: /)]);
    expect(body).not.toContain(job.id);
  });

  it('files the report as the person, labelled user-report, never as a job', async () => {
    const { app, github, token } = await start();
    const r = await app.ui<{ kind: string; number: number; url: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'filed', number: 1, url: `${github.url}/${REPO}/issues/1` });
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: REPORT.title, author: 'reporter', labels: ['user-report'], assignees: [] });
    expect(issue.body).toContain('### What happened\n\nThe board stopped.');
    expect(issue.body).toContain('### Context\n\n- System: linux 6.18.2 (x64), Node v24.3.0');
    const create = github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${REPO}/issues`))!;
    expect(create.auth).toContain('test-account-token');
    expect(eventsOf(app, 'bug_report.filed').map((e) => e.data)).toEqual([
      { repo: REPO, kind: 'issue', number: 1, url: `${github.url}/${REPO}/issues/1`, by: expect.any(String) },
    ]);
  });

  it('offers a similar open report first; the person comments on it, or files a new one anyway', async () => {
    const { app, github, token } = await start();
    github.issues.push({ repo: REPO, number: 5, title: 'Board hangs after a job fails', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    github.issues.push({ repo: REPO, number: 6, title: 'Board hangs after a job fails', body: '', author: 'someone', labels: ['user-report'], assignees: [], state: 'closed' });
    const r = await app.ui<{ kind: string; similar: { number: number; title: string; url: string }[] }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.body).toEqual({ kind: 'similar', similar: [{ number: 5, title: 'Board hangs after a job fails', url: `${github.url}/${REPO}/issues/5` }] });
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(2);

    const c = await app.ui<{ kind: string; number: number; url: string }>('/ui/api/bug-reports', { ...REPORT, commentOn: 5 }, { token });
    expect(c.body).toMatchObject({ kind: 'commented', number: 5 });
    const comment = github.issues.find((i) => i.number === 5)!.comments![0]!;
    expect(String(comment.body)).toContain('The board stopped.');
    expect(c.body.url).toBe(comment.html_url);

    const f = await app.ui<{ kind: string; number: number }>('/ui/api/bug-reports', { ...REPORT, force: true }, { token });
    expect(f.body).toMatchObject({ kind: 'filed', number: 7 });
    expect(eventsOf(app, 'bug_report.filed').map((e) => e.data.kind).sort()).toEqual(['comment', 'issue']);
  });

  it('keeps the report, with the reason, when the person has no GitHub connection', async () => {
    const { app, github, token } = await start({ connected: false });
    const r = await app.ui<{ kind: string; problem: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'kept', problem: expect.stringMatching(/GitHub is not connected/) });
    expect(github.issues).toHaveLength(0);
    expect(eventsOf(app, 'bug_report.failed')).toHaveLength(0);
  });

  it('refuses a report with no title or no text', async () => {
    const { app, token } = await start();
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, title: ' ' }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, happened: '' }, { token })).status).toBe(400);
  });
});
