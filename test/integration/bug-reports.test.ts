// Issue #694: Report a bug. A person reviews the redacted context, and the hopper files the report on the hopper's own
// repository through that person's GitHub connection. The daemon, store and HTTP edge are real; GitHub is a fake on
// loopback (test/support/fake-forges.ts).
//
// Feature: Report a bug
//   Scenario: the form's context is the OS and the hopper's version, masked, with the public warning (issue #2818)
//   Scenario: nothing is posted until an admin turns public bug reports on (issue #2818)
//     Given a hopper whose admin never turned public bug reports on
//     When the person sends a report
//     Then it is refused, and nothing reaches GitHub; an operator cannot turn them on, an admin can
//   Scenario: a report is filed as the person, labelled user-report, in the fixed template (issue #2818)
//     When the person previews, then sends a report
//     Then an issue is filed on henningfutrell/hopper with the person's own GitHub token, as the preview showed it
//     And it has the label user-report, no hopper label and no assignee, so it never starts a job
//     And its email addresses, links, absolute paths, host names and long ids are removed
//   Scenario: a similar open report is offered first
//   Scenario: with no GitHub connection the report is kept, with the reason (sent later: bug-reports-later.test.ts)
//   Scenario: a report with no title, no description, or one too long is refused
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

async function start(o: { connected?: boolean; publicReports?: boolean } = {}) {
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
  if (o.publicReports !== false) app.user(ADMIN_ID).store.settings.setPublicBugReports(true);
  const token = await app.login();
  return { app, github, token };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

const REPORT = { title: 'The board hangs when a job fails', description: 'The board stopped.' };
const WARNING = 'This report will be posted publicly on GitHub. Do not include names, emails, customer or company details, repository or host names, links, ids or file paths.';

describe('Report a bug', () => {
  it('answers the context of a report: the OS and the hopper\'s version only, with the public warning (issue #2818)', async () => {
    const { app, token } = await start();
    const r = await app.ui<{ context: string; repo: string; warning: string; on: boolean }>('/ui/api/bug-reports/context', {}, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ repo: REPO, warning: WARNING, on: true });
    expect(r.body.context).toMatch(/^- OS: \S+ \S+ \(\S+\)\n- Hopper version: \d+\.\d+\.\d+\S*$/);
    expect((await app.ui('/ui/api/bug-reports/context', { jobId: 'x' }, { token })).status).toBe(400);
  });

  it('posts nothing until an admin turns public bug reports on, and an operator cannot (issue #2818)', async () => {
    const { app, github, token } = await start({ publicReports: false });
    expect((await app.ui<{ on: boolean }>('/ui/api/bug-reports/context', {}, { token })).body.on).toBe(false);
    const off = await app.ui<{ error: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(off.status).toBe(409);
    expect(off.body.error).toContain('public bug reports are off');
    expect(github.requests.filter((q) => q.path.includes(REPO))).toHaveLength(0);
    expect(app.user(ADMIN_ID).store.bugReports.list()).toEqual([]);

    const opToken = await operatorSession(app);
    expect((await app.ui('/ui/api/bug-reports/settings', { on: true }, { token: opToken })).status).toBe(403);

    expect((await app.ui('/ui/api/bug-reports/settings', { on: true }, { token })).body).toEqual({ publicReports: true });
    expect((await app.ui<{ kind: string }>('/ui/api/bug-reports', REPORT, { token })).body.kind).toBe('filed');
  });

  it('files the report as the person, as its preview showed it: the fixed template, scrubbed, labelled user-report, never as a job (issue #2818)', async () => {
    const { app, github, token } = await start();
    const job = await app.pull({ op: 'fail', ms: 0, message: 'push failed' });
    await app.waitForStatus(job.id, 'failed');
    const draft = {
      title: 'The board hangs on db01.acme.com',
      description: 'It stopped. Mail jane@acme.com, see https://grafana.acme.example/d/1, /srv/acme/app.log, run 18234567890 and https://github.com/henningfutrell/hopper/issues/1.',
    };
    const preview = await app.ui<{ title: string; body: string; removed: string[]; warning: string }>('/ui/api/bug-reports/preview', draft, { token });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ title: 'The board hangs on [a host name]', warning: WARNING });
    expect(preview.body.removed.sort()).toEqual(['email address', 'file path', 'host name', 'link', 'long id']);
    expect(preview.body.body).toMatch(/^### Description\n\nIt stopped\. Mail \[an email address\], see \[a link\], \[a file path\], run \[an id\] and https:\/\/github\.com\/henningfutrell\/hopper\/issues\/1\.\n\n### System\n\n- OS: [^\n]+\n- Hopper version: \S+\n\n---\nFiled with Report a bug in a hopper\.$/);
    expect(github.requests.filter((q) => q.path.includes(REPO))).toHaveLength(0);

    const r = await app.ui<{ kind: string; number: number; url: string }>('/ui/api/bug-reports', { ...draft, jobId: job.id }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'filed', number: 1, url: `${github.url}/${REPO}/issues/1` });
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: preview.body.title, author: 'reporter', labels: ['user-report'], assignees: [] });
    expect(issue.body.startsWith(preview.body.body)).toBe(true);
    expect(issue.body).not.toContain(job.id);
    const create = github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${REPO}/issues`))!;
    expect(create.auth).toContain('test-account-token');
    expect(eventsOf(app, 'bug_report.filed').map((e) => e.data)).toEqual([
      { repo: REPO, kind: 'issue', number: 1, url: `${github.url}/${REPO}/issues/1`, jobId: job.id, by: expect.any(String) },
    ]);
    expect(app.user(ADMIN_ID).store.bugReports.list()[0]).toMatchObject({ jobId: job.id, removed: expect.arrayContaining(['email address', 'host name']) });
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

  it('refuses a report with no title, no description, or one too long, and free-form fields (issue #2818)', async () => {
    const { app, token } = await start();
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, title: ' ' }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, description: '' }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, title: 'x'.repeat(121) }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, description: 'x'.repeat(2001) }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/bug-reports', { ...REPORT, context: '- System: anything' }, { token })).status).toBe(400);
  });
});

/** A session of the admin user with the operator role, minted as the operator CLI mints one. */
async function operatorSession(a: TestApp): Promise<string> {
  const { createUiSessions } = await import('../../src/http/ui/sessions.ts');
  const { loadSignInConfig } = await import('../../src/auth/index.ts');
  const instance = a.app.instance;
  const sessions = createUiSessions({
    repo: instance.uiSessions, clock: { now: () => new Date() },
    signIn: { config: () => loadSignInConfig(instance.signInConfig.read()), checkGateway: async () => ({ ok: false as const, status: 403 as const, error: 'none' }) },
  });
  return sessions.create({ role: 'operator', identity: { realm: 'cli', subject: 'operator', name: 'operator', groups: [] }, userId: 'admin', lastsMs: 60_000 }).token;
}
