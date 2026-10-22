// Issue #694 (and #623: every UI action from the CLI): `hopper report …` from the operator CLI, by the UI's own path —
// the context the hopper fills in and masks, the report filed through the user's own GitHub connection, Your reports
// and its refresh — each answer as JSON. The daemon, store, HTTP edge and CLI are real; GitHub is a fake on loopback.
//
// Feature: Report a bug from the CLI
//   Scenario: the context is printed, masked, for the person to read first
//   Scenario: a report is filed as the person with the hopper's context, and Your reports lists it
//   Scenario: a report with the person's own context file carries that context, not the hopper's
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

async function start() {
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
  it('prints the context of a report: the System line only', async () => {
    const { app } = await start();
    const r = await hopper(app, ['report', 'context']);
    expect(r.code).toBe(0);
    const answer = JSON.parse(r.out) as { context: string; repo: string };
    expect(answer.repo).toBe(REPO);
    expect(answer.context).toMatch(/^- System: [^\n]+$/);
  });

  it('files a report as the person, with the hopper\'s context, and lists it in Your reports', async () => {
    const { app, github } = await start();
    const r = await hopper(app, ['report', 'bug', '--title', 'The board hangs', '--happened', 'The board stopped.', '--expected', 'It shows the failure.']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ kind: 'filed', number: 1, url: `${github.url}/${REPO}/issues/1` });
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: 'The board hangs', author: 'reporter', labels: ['user-report'] });
    expect(issue.body).toContain('### What I expected\n\nIt shows the failure.');
    expect(issue.body).toMatch(/### Context\n\n- System: [^\n]+\n\n---\n/);

    const list = await hopper(app, ['report', 'list']);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as { reports: unknown[] }).reports).toEqual([expect.objectContaining({ title: 'The board hangs', state: 'open', number: 1 })]);
    const refreshed = await hopper(app, ['report', 'refresh']);
    expect(refreshed.code).toBe(0);
    expect((JSON.parse(refreshed.out) as { reports: { state: string }[] }).reports.map((x) => x.state)).toEqual(['open']);
  });

  it('sends the person\'s own context and text from files', async () => {
    const { app, github } = await start();
    const dir = mkdtempSync(join(tmpdir(), 'hopper-report-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'context.md'), '- System: linux, edited');
    writeFileSync(join(dir, 'happened.md'), 'It stopped twice.');
    const r = await hopper(app, ['report', 'bug', '--title', 'The board hangs', '--happened-file', join(dir, 'happened.md'), '--context-file', join(dir, 'context.md')]);
    expect(r.code).toBe(0);
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue.body).toContain('It stopped twice.');
    expect(issue.body).toContain('### Context\n\n- System: linux, edited');
    expect(issue.body).not.toContain('- System: linux 6');
  });

  it('answers a similar open report first; --comment-on adds the report to it', async () => {
    const { app, github } = await start();
    github.issues.push({ repo: REPO, number: 5, title: 'Board hangs after a job fails', body: '', author: 'someone', labels: ['user-report'], assignees: [] });
    const first = await hopper(app, ['report', 'bug', '--title', 'The board hangs when a job fails', '--happened', 'The board stopped.']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual({ kind: 'similar', similar: [{ number: 5, title: 'Board hangs after a job fails', url: `${github.url}/${REPO}/issues/5` }] });
    const added = await hopper(app, ['report', 'bug', '--title', 'The board hangs when a job fails', '--happened', 'The board stopped.', '--comment-on', '5']);
    expect(JSON.parse(added.out)).toMatchObject({ kind: 'commented', number: 5 });
    expect(github.issues.find((i) => i.number === 5)!.comments).toHaveLength(1);
  });

  it('refuses a bad call with the usage', async () => {
    const { app } = await start();
    const r = await hopper(app, ['report', 'bug', '--happened', 'no title']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage: hopper report bug --title/);
    expect((await hopper(app, ['report', 'bug', '--title', 't', '--happened', 'x', '--comment-on', 'five'])).code).toBe(2);
    expect((await hopper(app, ['report', 'nothing'])).code).toBe(2);
  });
});
