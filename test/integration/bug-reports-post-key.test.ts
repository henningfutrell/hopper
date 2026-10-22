// Issue #1591: Report a bug never files a report twice. The report's row is kept before GitHub is asked, its post key in
// the text; before a create the hopper looks for that key on GitHub. A stop, or a timeout where GitHub did make the issue,
// links the issue GitHub made. The daemon, store and HTTP edge are real; GitHub is a fake on loopback
// (test/support/fake-forges.ts), and its answer to a create is lost to simulate the stop.
//
// Feature: Report a bug, filed once
//   Scenario: GitHub made the issue, and the answer was lost
//     Given GitHub makes the new issue, but the hopper reads 502
//     When the person sends a report
//     Then the report is kept
//     When the hopper sends the kept reports
//     Then one issue exists, and the report links it
//   Scenario: the hopper stopped after GitHub made the issue, before the row linked it
//     Given GitHub made the issue of a report, and the hopper stopped while the report was being sent
//     When the hopper starts again
//     Then one issue exists, and the report links it
//   Scenario: a comment too
//     Given GitHub adds the comment, but the hopper reads 502
//     When the hopper sends the kept report
//     Then one comment exists, and the report links the issue
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'henningfutrell/hopper';
const REPORT = { title: 'The board hangs when a job fails', happened: 'The board stopped.', expected: 'The board shows the failure.', context: '- System: linux 6.18.2 (x64), Node v24.3.0' };

interface ReportRow { id: string; state: string; kind: string; number?: number; url?: string }

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'reporter');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const env = { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' };
  const boot = async () => {
    const app = await startTestApp({ dbPath: db.dbPath, env });
    apps.push(app);
    return { app, token: await app.login() };
  };
  const first = await boot();
  connectGitHub(first.app, ['octo/tools'], { login: 'reporter' });
  return { github, ...first, boot };
}

const reportsOf = async (app: TestApp, token: string): Promise<ReportRow[]> => (await app.api<{ reports: ReportRow[] }>('GET', '/api/bug-reports', undefined, { 'x-hopper-session': token })).body.reports;
const refresh = async (app: TestApp, token: string): Promise<ReportRow[]> => (await app.ui<{ reports: ReportRow[] }>('/ui/api/bug-reports/refresh', {}, { token })).body.reports;

describe('Report a bug files a report once (issue #1591)', () => {
  it('links the issue GitHub made when its answer was lost', async () => {
    const { app, github, token } = await start();
    github.answerLost = 502;
    const r = await app.ui<{ kind: string; id: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.body).toMatchObject({ kind: 'kept', id: expect.any(String) });
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(1);

    github.answerLost = undefined;
    const after = await refresh(app, token);
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(1);
    expect(after).toEqual([expect.objectContaining({ id: r.body.id, state: 'open', number: 1, url: `${github.url}/${REPO}/issues/1` })]);
    await refresh(app, token);
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(1);
  });

  it('links the issue GitHub made before the hopper stopped, at the next start', async () => {
    const { app, github, token, boot } = await start();
    github.answerLost = 502;
    const r = await app.ui<{ kind: string; id: string }>('/ui/api/bug-reports', REPORT, { token });
    expect(r.body.kind).toBe('kept');
    // The hopper stopped while it sent the report: the row is as the send left it.
    app.user(ADMIN_ID).store.bugReports.update(r.body.id, { state: 'sending', problem: undefined });
    github.answerLost = undefined;
    await app.stop();

    const again = await boot();
    const linked = await waitFor(async () => (await reportsOf(again.app, again.token)).find((x) => x.id === r.body.id && x.state === 'open'), { what: 'the report linked' });
    expect(linked).toMatchObject({ number: 1, url: `${github.url}/${REPO}/issues/1` });
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(1);
  });

  it('adds a comment once when its answer was lost', async () => {
    const { app, github, token } = await start();
    github.issues.push({ repo: REPO, number: 5, title: 'Board hangs after a job fails', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    github.answerLost = 502;
    const r = await app.ui<{ kind: string }>('/ui/api/bug-reports', { ...REPORT, commentOn: 5 }, { token });
    expect(r.body.kind).toBe('kept');
    github.answerLost = undefined;
    const after = await refresh(app, token);
    expect(after).toEqual([expect.objectContaining({ kind: 'comment', state: 'open', number: 5 })]);
    expect(github.issues.find((i) => i.number === 5)!.comments).toHaveLength(1);
  });
});
