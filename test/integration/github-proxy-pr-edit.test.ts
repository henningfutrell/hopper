// Issue #1734: a job changes the title or body of a pull request, or closes it with no merge, through the hopper. The
// daemon, store and HTTP edge are real; GitHub is a fake on loopback (test/support/fake-forges.ts); the job runs the
// real `hopper-gh` script (sh and curl) against the hopper.
//
// Feature: a job edits or closes its own pull request
//   Scenario: a job edits the body of a pull request it opened, then closes it
//     Given a job that opened pull request #8 through the hopper
//     When it runs `pr edit 8 --body-file …`, then `pr close 8`
//     Then GitHub changes the body with the job's user's connection, then closes the pull request, with no merge
//     And each is on the job's timeline (`github_proxy.done`)
//   Scenario: a job edits the pull request of its own work item, which it did not open
//   Scenario: a job asks to edit or close a pull request that is not its own
//     Then it is refused with the reason, and nothing reaches GitHub
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
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

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-pr-edit-'));
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
  connectGitHub(app, ['octo/tools']);
  github.issues.push({ repo: 'octo/tools', number: 7, title: 'Make it faster', body: 'Please.', author: 'someone', labels: ['hopper'] });
  const issueUrl = `${github.url}/octo/tools/issues/7`;
  const job = await app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7, key: issueUrl, url: issueUrl });
  const env = await waitFor(async () => h.held.get(job.id)?.env, { what: 'the job to run' });
  return { app, github, root, job, env };
}

/** A pull request opened on the fake GitHub by someone else, not through the hopper. */
async function openElsewhere(github: { url: string }, head: string): Promise<number> {
  const res = await fetch(`${github.url}/api/v3/repos/octo/tools/pulls`, {
    method: 'POST', headers: { authorization: 'token test-account-token', 'content-type': 'application/json' },
    body: JSON.stringify({ head, base: 'dev', title: 'Other work', body: 'Not the job\'s.' }),
  });
  return ((await res.json()) as { number: number }).number;
}

const patches = (github: { requests: { method: string; path: string }[] }) => github.requests.filter((r) => r.method === 'PATCH' && r.path.includes('/pulls/'));
const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

describe('a job edits or closes its own pull request (issue #1734)', () => {
  it('edits the body and the title of a pull request it opened, then closes it with no merge', async () => {
    const t = await start();
    const opened = await hopperGh(t.root, t.env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7-faster', '--title', 'Faster', '--body', 'Closes #7']);
    expect(json(opened)).toMatchObject({ number: 8 });
    const bodyFile = join(t.root, 'body.md');
    writeFileSync(bodyFile, 'Closes #7\n\n## Plan\n- one step\n');

    const edit = await hopperGh(t.root, t.env, ['pr', 'edit', '8', '--repo', 'octo/tools', '--title', 'Make the queue faster', '--body-file', bodyFile]);
    expect(edit.code).toBe(0);
    expect(json(edit)).toMatchObject({ ok: true, op: 'pr.edit', repo: 'octo/tools', number: 8, title: 'Make the queue faster', state: 'open', as: 'owner' });
    expect(patches(t.github)[0]).toMatchObject({ auth: 'token test-account-token', body: { title: 'Make the queue faster', body: 'Closes #7\n\n## Plan\n- one step\n' } });
    expect(json(await hopperGh(t.root, t.env, ['pr', 'view', '8', '--repo', 'octo/tools']))).toMatchObject({ title: 'Make the queue faster', body: 'Closes #7\n\n## Plan\n- one step\n' });

    const close = await hopperGh(t.root, t.env, ['pr', 'close', '8', '--repo', 'octo/tools']);
    expect(json(close)).toMatchObject({ ok: true, op: 'pr.close', number: 8, state: 'closed', merged: false });
    expect(patches(t.github)[1]).toMatchObject({ body: { state: 'closed' } });
    expect(eventsOf(t.app, 'github_proxy.done').filter((e) => e.jobId === t.job.id).map((e) => e.data.op)).toEqual(expect.arrayContaining(['pr.edit', 'pr.close']));
  });

  it('edits the pull request of its own work item, which an earlier job opened', async () => {
    const t = await start();
    const n = await openElsewhere(t.github, 'issue-7-earlier');
    t.app.user(ADMIN_ID).store.events.append({ type: 'job.pull_request_followed', jobId: t.job.id, data: { pullRequest: `${t.github.url}/octo/tools/pull/${n}`, part: false } });
    await waitFor(async () => t.app.user(ADMIN_ID).store.workItems.get(`${t.github.url}/octo/tools/issues/7`)?.pullRequest, { what: 'the work item to name the pull request' });

    const edit = await hopperGh(t.root, t.env, ['pr', 'edit', String(n), '--repo', 'octo/tools', '--body', 'Closes #7']);
    expect(json(edit)).toMatchObject({ ok: true, op: 'pr.edit', number: n });
  });

  it('refuses a pull request the job did not open and that is not its work item\'s; nothing reaches GitHub', async () => {
    const t = await start();
    const n = await openElsewhere(t.github, 'someone-else');
    for (const args of [['pr', 'edit', String(n), '--repo', 'octo/tools', '--body', 'x'], ['pr', 'close', String(n), '--repo', 'octo/tools']]) {
      const r = await hopperGh(t.root, t.env, args);
      expect(r.code).toBe(1);
      expect(json(r).error).toBe(`refused: a job edits or closes only a pull request it opened, or the pull request of its own work item: not octo/tools#${n}`);
    }
    const none = await hopperGh(t.root, t.env, ['pr', 'edit', String(n), '--repo', 'octo/tools']);
    expect(json(none).error).toMatch(/pr edit needs --title or --body/);
    expect(patches(t.github)).toEqual([]);
    expect(eventsOf(t.app, 'github_proxy.refused').map((e) => e.data.op)).toEqual(['pr.edit', 'pr.close', 'pr.edit']);
  });
});
