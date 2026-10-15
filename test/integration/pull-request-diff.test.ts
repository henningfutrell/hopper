// Issue #1169: a person reads a job repository's pull request diff on the Pull requests page. The daemon, store and HTTP
// edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts), read with the person's own GitHub connection.
//
// Feature: A pull request's diff
//   Scenario: an operator reads the diff of a pull request of a job repository
//     Then it answers each file, and each file's patch as `git diff` writes it
//     And it changes and records nothing
//   Scenario: a repository that is not a job repository, or a body that names none, is refused
//   Scenario: with no GitHub connection, it says so
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import type { PullRequestDiff } from '../../src/domain/pull-request-diff.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function start(o: { connected?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.pullFiles = { 'octo/tools#8': [
    { filename: 'src/queue.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-slow()\n+fast()' },
    { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
  ] };
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  if (o.connected !== false) connectGitHub(app, ['octo/tools']);
  else app.user(ADMIN_ID).store.settings.setJobRepositories('github', ['octo/tools']);
  return { app, github, token: await app.login() };
}

describe('A pull request\'s diff', () => {
  it('answers each file and its patch, read with the person\'s own connection, and records nothing', async () => {
    const { app, github, token } = await start();
    const before = app.user(ADMIN_ID).store.events.recent(1000).length;
    const r = await app.ui<PullRequestDiff>('/ui/api/pull-requests/diff', { repo: 'Octo/Tools', number: 8 }, { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      number: 8, url: `${github.url}/octo/tools/pull/8`,
      files: [{ file: 'src/queue.ts', status: 'modified', additions: 1, deletions: 1 }, { file: 'logo.png', status: 'added', additions: 0, deletions: 0 }],
      diff: 'diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -1 +1 @@\n-slow()\n+fast()\n'
        + 'diff --git a/logo.png b/logo.png\n--- /dev/null\n+++ b/logo.png\n(no patch: binary, or too large for GitHub to show)\n',
    });
    const read = github.requests.find((q) => q.method === 'GET' && q.path.endsWith('/repos/Octo/Tools/pulls/8/files'))
      ?? github.requests.find((q) => q.method === 'GET' && q.path.endsWith('/repos/octo/tools/pulls/8/files'));
    expect(read?.auth).toContain('test-account-token');
    expect(app.user(ADMIN_ID).store.events.recent(1000).length).toBe(before);
  });

  it('refuses a repository that is not a job repository, and a body that names no pull request', async () => {
    const { app, token } = await start();
    expect((await app.ui('/ui/api/pull-requests/diff', { repo: 'someone/else', number: 8 }, { token })).status).toBe(404);
    expect((await app.ui('/ui/api/pull-requests/diff', { repo: 'not a repo', number: 8 }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/pull-requests/diff', { repo: 'octo/tools' }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/pull-requests/diff', { repo: 'octo/tools', number: 8 })).status).toBe(403);
  });

  it('with no GitHub connection, says so', async () => {
    const { app, token } = await start({ connected: false });
    const r = await app.ui<{ error: string }>('/ui/api/pull-requests/diff', { repo: 'octo/tools', number: 8 }, { token });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/not connected/);
  });
});
