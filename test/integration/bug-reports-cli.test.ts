// Issue #694 (and #623: every UI action from the CLI): `hopper report …` from the operator CLI, by the UI's own path —
// the context the hopper fills in and masks, the report filed through the user's own GitHub connection, Your reports
// and its refresh — each answer as JSON. The daemon, store, HTTP edge and CLI are real; GitHub is a fake on loopback.
//
// Feature: Report a bug from the CLI
//   Scenario: the context is printed, masked: the OS and the hopper's version (issue #2818)
//   Scenario: public bug reports are off until an admin turns them on with `report public on` (issue #2818)
//   Scenario: a report is filed as the person with the hopper's context, and Your reports lists it
//   Scenario: the preview shows the report as it would be posted, scrubbed; the description comes from a file too
//   Scenario: a similar open report is answered first; --comment-on adds the report to it
//   Scenario: a bad call is refused with the usage
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

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
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools'], { login: 'reporter' });
  if (o.publicReports !== false) app.user().store.settings.setPublicBugReports(true);
  return { app, github };
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url, '--user', 'admin'], io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('hopper report (issue #694)', () => {
  it('prints the context of a report: the OS and the hopper\'s version, with the public warning', async () => {
    const { app } = await start();
    const r = await hopper(app, ['report', 'context']);
    expect(r.code).toBe(0);
    const answer = JSON.parse(r.out) as { context: string; repo: string; warning: string; on: boolean };
    expect(answer).toMatchObject({ repo: REPO, on: true, warning: expect.stringContaining('posted publicly on GitHub') });
    expect(answer.context).toMatch(/^- OS: [^\n]+\n- Hopper version: \S+$/);
  });

  it('refuses a report until an admin turns public bug reports on (issue #2818)', async () => {
    const { app, github } = await start({ publicReports: false });
    const off = await hopper(app, ['report', 'bug', '--title', 'The board hangs', '--description', 'The board stopped.']);
    expect(off.code).not.toBe(0);
    expect(off.err).toContain('public bug reports are off');
    expect(github.issues.filter((i) => i.repo === REPO)).toHaveLength(0);
    expect(JSON.parse((await hopper(app, ['report', 'public', 'on'])).out)).toEqual({ publicReports: true });
    expect((await hopper(app, ['report', 'bug', '--title', 'The board hangs', '--description', 'The board stopped.'])).code).toBe(0);
    expect(JSON.parse((await hopper(app, ['report', 'public', 'off'])).out)).toEqual({ publicReports: false });
    expect((JSON.parse((await hopper(app, ['report', 'list'])).out) as { publicReports: boolean }).publicReports).toBe(false);
  });

  it('files a report as the person, with the hopper\'s context, and lists it in Your reports', async () => {
    const { app, github } = await start();
    const r = await hopper(app, ['report', 'bug', '--title', 'The board hangs', '--description', 'The board stopped.']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ kind: 'filed', number: 1, url: `${github.url}/${REPO}/issues/1` });
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: 'The board hangs', author: 'reporter', labels: ['user-report'] });
    expect(issue.body).toMatch(/^### Description\n\nThe board stopped\.\n\n### System\n\n- OS: [^\n]+\n- Hopper version: \S+\n\n---\n/);

    const list = await hopper(app, ['report', 'list']);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as { reports: unknown[] }).reports).toEqual([expect.objectContaining({ title: 'The board hangs', state: 'open', number: 1 })]);
    const refreshed = await hopper(app, ['report', 'refresh']);
    expect(refreshed.code).toBe(0);
    expect((JSON.parse(refreshed.out) as { reports: { state: string }[] }).reports.map((x) => x.state)).toEqual(['open']);
  });

  it('previews the report as it would be posted, scrubbed; the description comes from a file too', async () => {
    const { app, github } = await start();
    const dir = mkdtempSync(join(tmpdir(), 'hopper-report-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'description.md'), 'It stopped twice; ask ops@acme.example.');
    const preview = await hopper(app, ['report', 'preview', '--title', 'The board hangs', '--description-file', join(dir, 'description.md')]);
    expect(preview.code).toBe(0);
    const p = JSON.parse(preview.out) as { title: string; body: string; removed: string[] };
    expect(p).toMatchObject({ title: 'The board hangs', removed: ['email address'] });
    expect(p.body).toContain('It stopped twice; ask [an email address].');
    expect(github.issues).toHaveLength(0);
    expect((await hopper(app, ['report', 'bug', '--title', 'The board hangs', '--description-file', join(dir, 'description.md')])).code).toBe(0);
    expect(github.issues.find((i) => i.repo === REPO)!.body.startsWith(p.body)).toBe(true);
  });

  it('answers a similar open report first; --comment-on adds the report to it', async () => {
    const { app, github } = await start();
    github.issues.push({ repo: REPO, number: 5, title: 'Board hangs after a job fails', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    const first = await hopper(app, ['report', 'bug', '--title', 'The board hangs when a job fails', '--description', 'The board stopped.']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual({ kind: 'similar', similar: [{ number: 5, title: 'Board hangs after a job fails', url: `${github.url}/${REPO}/issues/5` }] });
    const added = await hopper(app, ['report', 'bug', '--title', 'The board hangs when a job fails', '--description', 'The board stopped.', '--comment-on', '5']);
    expect(JSON.parse(added.out)).toMatchObject({ kind: 'commented', number: 5 });
    expect(github.issues.find((i) => i.number === 5)!.comments).toHaveLength(1);
  });

  it('refuses a bad call with the usage', async () => {
    const { app } = await start();
    const r = await hopper(app, ['report', 'bug', '--description', 'no title']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage: hopper report bug --title/);
    expect((await hopper(app, ['report', 'bug', '--title', 't', '--description', 'x', '--comment-on', 'five'])).code).toBe(2);
    expect((await hopper(app, ['report', 'public', 'maybe'])).code).toBe(2);
    expect((await hopper(app, ['report', 'approve'])).code).toBe(2);
    expect((await hopper(app, ['report', 'nothing'])).code).toBe(2);
  });
});
