// Issue #1607: a job's write through the GitHub proxy sent again after its answer was lost.
//
//   Given a running job of octo/tools#7
//   When  hopper-gh files an issue and the answer is lost on the way back
//   Then  hopper-gh sends it again with the same key, and the hopper answers the first issue again
//     And GitHub holds one issue, linked as a sub-issue of octo/tools#7
//   When  GitHub makes the issue and then fails, and hopper-gh sends it again with its key (issue #1959 part 2)
//   Then  the hopper finds it on GitHub by its post key: one issue, linked once
//   When  GitHub refuses the sub-issue link at first
//   Then  the hopper keeps the link and makes it at a later try
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'hopper-resend-machine-'));
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
  github.issues.push({ repo: 'octo/tools', number: 7, title: 'Ship it in parts', body: 'Please.', author: 'owner', labels: ['hopper'] });
  const job = await app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7 }, ADMIN_ID);
  const env = await waitFor(async () => h.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { app, github, root, env, jobId: job.id };
}

/**
 * Between the job and the hopper: each request goes on to the hopper, but the answer to the first request whose body
 * holds `drop` never comes back — the connection breaks once the hopper answered it.
 */
async function lossyLink(target: string, drop: string): Promise<{ url: string; dropped: () => number }> {
  const to = new URL(target);
  let dropped = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const lose = dropped === 0 && body.toString().includes(drop);
      const up = request({ host: to.hostname, port: to.port, path: req.url, method: req.method, headers: { ...req.headers, host: to.host } }, (answer) => {
        const back: Buffer[] = [];
        answer.on('data', (c: Buffer) => back.push(c));
        answer.on('end', () => {
          if (lose) { dropped += 1; req.socket.destroy(); return; }
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          res.end(Buffer.concat(back));
        });
      });
      up.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const at = server.address();
  if (!at || typeof at === 'string') throw new Error('no address');
  return { url: `http://127.0.0.1:${at.port}`, dropped: () => dropped };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const created = (f: FakeForge) => f.issues.filter((i) => i.repo === 'octo/tools' && i.number !== 7);

describe('a job\'s write sent again after its answer was lost (issue #1607)', () => {
  it('an issue create: hopper-gh sends it again with its key; one issue exists, linked as a sub-issue', async () => {
    const t = await start();
    const link = await lossyLink(t.app.url, 'op=issue.create');
    const r = await hopperGh(t.root, { ...t.env, HOPPER_URL: link.url }, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Fix first', '--body', 'Needed.', '--required']);
    expect(link.dropped()).toBe(1);
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', required: true, subIssue: true, replayed: true });
    expect(created(t.github).map((i) => i.number)).toEqual([8]);
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues).toEqual(['octo/tools#8']);
    expect(eventsOf(t.app, 'job.child_issue_filed')).toHaveLength(1);
  });

  it('an issue comment: hopper-gh sends it again with its key; one comment exists', async () => {
    const t = await start();
    const link = await lossyLink(t.app.url, 'op=issue.comment');
    const r = await hopperGh(t.root, { ...t.env, HOPPER_URL: link.url }, ['issue', 'comment', '7', '--repo', 'octo/tools', '--body', 'Found the cause.']);
    expect(link.dropped()).toBe(1);
    expect(json(r)).toMatchObject({ ok: true, op: 'issue.comment', number: 7, replayed: true });
    expect(t.github.issues.find((i) => i.number === 7)!.comments).toHaveLength(1);
  });

  it('the same text sent again as a new command is a new comment: the key is the command\'s, not the text\'s', async () => {
    const t = await start();
    for (let i = 0; i < 2; i++) expect(json(await hopperGh(t.root, t.env, ['issue', 'comment', '7', '--repo', 'octo/tools', '--body', 'Rebased.']))).not.toHaveProperty('replayed');
    expect(t.github.issues.find((i) => i.number === 7)!.comments).toHaveLength(2);
  });

  // Issue #1959 part 2: the answer was not lost on the way back, GitHub failed it after it made the issue.
  it('an issue GitHub made and then failed, sent again with its key: found by its post key, one issue, linked once', async () => {
    const t = await start();
    t.github.answerLost = 502;
    const first = await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Fix first', '--body', 'Needed.', '--required', '--key', 'fix-first-1']);
    expect(first.code).not.toBe(0);
    expect(created(t.github)).toHaveLength(1);
    t.github.answerLost = undefined;
    const again = await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Fix first', '--body', 'Needed.', '--required', '--key', 'fix-first-1']);
    expect(json(again)).toMatchObject({ ok: true, number: 8, parent: 'octo/tools#7', required: true, subIssue: true, found: true });
    expect(created(t.github).map((i) => i.number)).toEqual([8]);
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues).toEqual(['octo/tools#8']);
    expect(eventsOf(t.app, 'github_proxy.sending').map((e) => e.data.key)).toEqual(['fix-first-1', 'fix-first-1']);
  });

  it('a comment GitHub made and then failed, sent again with its key: found by its post key, one comment', async () => {
    const t = await start();
    t.github.answerLost = 502;
    expect((await hopperGh(t.root, t.env, ['issue', 'comment', '7', '--repo', 'octo/tools', '--body', 'Found the cause.', '--key', 'the-cause-1'])).code).not.toBe(0);
    t.github.answerLost = undefined;
    const again = await hopperGh(t.root, t.env, ['issue', 'comment', '7', '--repo', 'octo/tools', '--body', 'Found the cause.', '--key', 'the-cause-1']);
    expect(json(again)).toMatchObject({ ok: true, op: 'issue.comment', number: 7, found: true });
    const comments = t.github.issues.find((i) => i.number === 7)!.comments!;
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!.body)).toMatch(/^Found the cause\.\n\n<!-- hopper post proxy-[0-9a-f]{24} -->$/);
  });

  it('a sub-issue link GitHub refused is kept and tried again until it is made', async () => {
    const t = await start();
    t.github.subIssuesRefused = 422;
    const r = await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/tools', '--title', 'Fix first', '--body', 'Needed.', '--required']);
    expect(json(r)).toMatchObject({ ok: true, number: 8, subIssue: false, subIssueLater: true });
    const links = t.app.user(ADMIN_ID).githubProxy.subIssueLinks;
    await links.retry();
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues ?? []).toEqual([]);
    expect(eventsOf(t.app, 'job.sub_issue_linked')).toEqual([]);
    t.github.subIssuesRefused = undefined;
    await links.retry();
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues).toEqual(['octo/tools#8']);
    expect(eventsOf(t.app, 'job.sub_issue_linked')).toEqual([expect.objectContaining({
      jobId: t.jobId, data: expect.objectContaining({ parent: { repo: 'octo/tools', number: 7 }, child: expect.objectContaining({ repo: 'octo/tools', number: 8 }) }),
    })]);
    await links.retry();
    expect(t.github.issues.find((i) => i.number === 7)!.subIssues).toEqual(['octo/tools#8']);
    expect(eventsOf(t.app, 'job.sub_issue_linked')).toHaveLength(1);
  });
});
