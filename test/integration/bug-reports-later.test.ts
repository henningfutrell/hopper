// Issue #694: a bug report the hopper cannot file now is kept and sent later, and Your reports lists every report with
// its state on GitHub. The daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts).
//
// Feature: Report a bug, later
//   Scenario: with no GitHub connection the report is kept, and sent once the person connects
//     Given a person with no GitHub connection
//     When they send a report
//     Then the answer says it is kept, and why, and Your reports lists it as waiting
//     When they connect GitHub and the hopper sends the kept reports
//     Then the issue is filed as the person, labelled user-report, and Your reports lists it as open, with its link
//   Scenario: with no access to the repository the report is kept, a comment too
//     Given GitHub refuses a new issue or comment on the hopper's repository
//     When the person sends a report, and adds one to a similar open report
//     Then both are kept; once GitHub takes them, the issue is filed and the comment added
//   Scenario: Your reports refreshes each report's state from GitHub
//     Given a filed report
//     When its issue is closed on GitHub and the person refreshes Your reports
//     Then Your reports lists it as closed, with when and why it was closed (issue #1147)
//   Scenario: GitHub refusing the report itself is not kept
//     Given GitHub answers 422 to the new issue
//     Then the report fails with the reason, and nothing waits
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
const REPORT = { title: 'The board hangs when a job fails', happened: 'The board stopped.', expected: 'The board shows the failure.', context: '- System: linux 6.18.2 (x64), Node v24.3.0' };

interface ReportRow { id: string; title: string; state: string; kind: string; number?: number; url?: string; problem?: string; body?: string; tries: number; closedAt?: string; closedAs?: string }

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
  const yourReports = async (): Promise<ReportRow[]> => {
    const r = await app.api<{ reports: ReportRow[] }>('GET', '/api/bug-reports', undefined, { 'x-hopper-session': token });
    expect(r.status).toBe(200);
    return r.body.reports;
  };
  const refresh = async (): Promise<ReportRow[]> => {
    const r = await app.ui<{ reports: ReportRow[] }>('/ui/api/bug-reports/refresh', {}, { token });
    expect(r.status).toBe(200);
    return r.body.reports;
  };
  return { app, github, token, yourReports, refresh };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

describe('Report a bug, later', () => {
  it('keeps a report while GitHub is not connected, and sends it once it is', async () => {
    const { app, github, token, yourReports, refresh } = await start({ connected: false });
    const r = await app.ui<{ kind: string; id: string; problem: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: 'kept', id: expect.any(String), problem: expect.stringMatching(/GitHub is not connected/) });
    expect(github.issues).toHaveLength(0);
    expect(eventsOf(app, 'bug_report.kept').map((e) => e.data)).toEqual([{ repo: REPO, id: r.body.id, problem: expect.stringMatching(/not connected/), by: expect.any(String) }]);
    expect(eventsOf(app, 'bug_report.failed')).toHaveLength(0);
    const waiting = await yourReports();
    expect(waiting).toEqual([expect.objectContaining({ id: r.body.id, title: REPORT.title, state: 'waiting', kind: 'issue', problem: expect.stringMatching(/not connected/) })]);
    expect(waiting[0]).not.toHaveProperty('body');

    // Still no connection: the next pass keeps it, and counts the try.
    expect((await refresh())[0]).toMatchObject({ state: 'waiting', tries: 2 });

    connectGitHub(app, ['octo/tools'], { login: 'reporter' });
    const after = await refresh();
    expect(after).toEqual([expect.objectContaining({ id: r.body.id, state: 'open', number: 1, url: `${github.url}/${REPO}/issues/1` })]);
    expect(after[0]).not.toHaveProperty('problem');
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: REPORT.title, author: 'reporter', labels: ['user-report'], assignees: [] });
    expect(issue.body).toContain('### What happened\n\nThe board stopped.');
    expect(eventsOf(app, 'bug_report.filed').map((e) => e.data)).toEqual([
      { repo: REPO, kind: 'issue', number: 1, url: `${github.url}/${REPO}/issues/1`, by: expect.any(String), id: r.body.id, later: true },
    ]);
    // Sent once: a later pass files nothing again.
    await refresh();
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(1);
  });

  it('keeps a report and a comment while GitHub refuses access to the repository, and sends both later', async () => {
    const { app, github, token, refresh } = await start();
    github.issues.push({ repo: REPO, number: 5, title: 'Board hangs after a job fails', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    github.issuesRefused = 403;
    const kept = await app.ui<{ kind: string; problem: string }>('/ui/api/bug-reports', { ...REPORT, force: true }, { token });
    expect(kept.body).toMatchObject({ kind: 'kept', problem: expect.stringMatching(/403/) });
    const comment = await app.ui<{ kind: string }>('/ui/api/bug-reports', { ...REPORT, commentOn: 5 }, { token });
    expect(comment.body).toMatchObject({ kind: 'kept' });
    expect((await refresh()).map((r) => r.state)).toEqual(['waiting', 'waiting']);

    github.issuesRefused = undefined;
    const after = await refresh();
    expect(after.map((r) => [r.kind, r.state, r.number])).toEqual([['comment', 'open', 5], ['issue', 'open', 6]]);
    expect(String(github.issues.find((i) => i.number === 5)!.comments![0]!.body)).toContain('The board stopped.');
    expect(github.issues.find((i) => i.number === 6)).toMatchObject({ labels: ['user-report'] });
  });

  it('lists each filed report in Your reports, and refreshes its state from GitHub', async () => {
    const { app, github, token, yourReports, refresh } = await start();
    const r = await app.ui<{ kind: string; number: number }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.body).toMatchObject({ kind: 'filed', number: 1 });
    expect(await yourReports()).toEqual([expect.objectContaining({ title: REPORT.title, state: 'open', kind: 'issue', number: 1 })]);
    const issue = github.issues.find((i) => i.repo === REPO && i.number === 1)!;
    Object.assign(issue, { state: 'closed', stateReason: 'completed', closedAt: '2026-10-14T20:00:00Z' });
    expect((await refresh()).map((x) => [x.state, x.closedAs, x.closedAt])).toEqual([['closed', 'completed', '2026-10-14T20:00:00Z']]);
    issue.state = 'open';
    expect((await refresh()).map((x) => [x.state, x.closedAs, x.closedAt])).toEqual([['open', undefined, undefined]]);
  });

  it('does not keep a report that GitHub refuses for itself', async () => {
    const { app, github, token, yourReports } = await start();
    github.issuesRefused = 422;
    const r = await app.ui<{ error: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/422/);
    expect(await yourReports()).toEqual([]);
    expect(eventsOf(app, 'bug_report.failed')).toHaveLength(1);
  });
});
