// GitHub deliveries (issue #1079, design.md "GitHub deliveries"): the hopper takes GitHub's `issues` webhook at
// POST /github/webhook, signed with the GitHub webhook secret the hopper's admin made on Settings → GitHub webhook. A
// delivery whose signature holds names a repository: each source whose job repository it is syncs a few seconds later,
// and the delivery is a `source.delivery_received` in that user's log. A wrong or missing signature changes nothing; with
// no secret the route takes nothing; a delivery GitHub sends again is taken once.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobSource } from '../../src/domain/ports.ts';
import { spec } from '../store/helpers.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'octocat/hello';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

/** A job source whose one job repository is REPO: what it was told, and its timed syncs. */
function scriptedSource() {
  const told: string[] = [];
  let timed = 0;
  const source: JobSource = {
    name: 'gh', kind: 'github-account', describe: () => ({}),
    async discover(d) { if (d?.due) timed += 1; return []; },
    async check() { return []; },
    async report() { return {}; },
    repoChanged(repo) { told.push(repo); return repo.toLowerCase() === REPO; },
  };
  return { source, told, timed: () => timed };
}

async function boot() {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const s = scriptedSource();
  const a = await startTestApp({ dbPath: db.dbPath, seams: { sources: [s.source] } });
  apps.push(a);
  return { a, ...s, token: await a.login() };
}

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function deliver(a: TestApp, o: { body: unknown; event?: string; id?: string; signature?: string | null; secret?: string; contentType?: string }) {
  const body = JSON.stringify(o.body);
  const signature = o.signature === undefined ? sign(o.secret ?? '', body) : o.signature;
  return rawRequest(a.url, {
    method: 'POST', path: '/github/webhook', body,
    headers: {
      'content-type': o.contentType ?? 'application/json', 'x-github-event': o.event ?? 'issues', 'x-github-delivery': o.id ?? 'd-1',
      'user-agent': 'GitHub-Hookshot/abc', ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
    },
  });
}

const labelled = (repo = REPO) => ({ action: 'labeled', issue: { number: 7 }, label: { name: 'hopper' }, repository: { full_name: repo } });

describe('GitHub deliveries (issue #1079)', () => {
  it('takes nothing until the admin makes a secret', async () => {
    const { a, told } = await boot();
    expect((await deliver(a, { body: labelled() })).status).toBe(404);
    expect(told).toEqual([]);
    const view = (await a.api('GET', '/api/github-deliveries')).body;
    expect(view).toMatchObject({ path: '/github/webhook', events: ['issues'], secret: { set: false } });
  });

  it('a signed delivery makes its sources sync soon and is recorded; a wrong or missing signature changes nothing', async () => {
    const { a, told, timed, token } = await boot();
    const made = await a.ui<{ generatedSecret: string; secret: { set: boolean; last4: string } }>('/ui/api/github-deliveries', { action: 'make' }, { token });
    expect(made.status).toBe(200);
    const secret = made.body.generatedSecret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(made.body.secret).toMatchObject({ set: true, last4: secret.slice(-4) });
    // The secret is never read back.
    expect(JSON.stringify((await a.api('GET', '/api/github-deliveries')).body)).not.toContain(secret);

    expect((await deliver(a, { body: labelled(), signature: sign('not the secret', JSON.stringify(labelled())) })).status).toBe(401);
    expect((await deliver(a, { body: labelled(), signature: null })).status).toBe(401);
    expect(told).toEqual([]);

    const before = timed();
    expect((await deliver(a, { body: labelled(), secret, id: 'd-1' })).status).toBe(202);
    expect(told).toEqual([REPO]);
    await waitFor(async () => (timed() > before ? true : undefined), { timeoutMs: 10_000, what: 'a timed sync after the delivery' });
    expect((await a.events('types=source.delivery_received')).map((e) => e.data)).toEqual([
      { sources: ['gh'], delivery: 'd-1', event: 'issues', action: 'labeled', repo: REPO, number: 7 },
    ]);

    // GitHub sends the same delivery again (a redelivery): taken once.
    expect((await deliver(a, { body: labelled(), secret, id: 'd-1' })).status).toBe(200);
    expect(told).toEqual([REPO]);

    // A repository no source takes: nothing recorded.
    expect((await deliver(a, { body: labelled('someone/else'), secret, id: 'd-2' })).status).toBe(202);
    expect(await a.events('types=source.delivery_received')).toHaveLength(1);

    // GitHub's ping when the webhook is made, and an event the hopper does not take.
    expect((await deliver(a, { body: { zen: 'Keep it logically awesome.', hook_id: 1 }, event: 'ping', secret, id: 'd-3' })).status).toBe(200);
    expect((await deliver(a, { body: { ref: 'refs/heads/main', repository: { full_name: REPO } }, event: 'push', secret, id: 'd-4' })).status).toBe(202);
    expect(told).toEqual([REPO, 'someone/else']);

    const view = (await a.api('GET', '/api/github-deliveries')).body;
    expect(view).toMatchObject({ received: 2, refused: 2, ignored: 2, last: { delivery: 'd-2', event: 'issues', action: 'labeled', repo: 'someone/else' } });
    expect(view.lastRefused).toMatchObject({ why: 'no signature' });
  });

  it('an issue closed or reopened that is a work item moves its item in the ledger (issue #1067)', async () => {
    const { a, token } = await boot();
    const secret = (await a.ui<{ generatedSecret: string }>('/ui/api/github-deliveries', { action: 'make' }, { token })).body.generatedSecret;
    const key = `https://github.com/${REPO}/issues/7`;
    const { store } = a.user();
    const job = store.jobs.create(spec, 50, { source: 'gh', kind: 'github-account', key, repo: REPO, number: 7 });
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.failed', jobId: job.id, data: { error: 'boom' } });
    expect(store.workItems.get(key)?.state).toBe('failed');

    const closed = (action: string, reason?: string) => ({
      action, issue: { number: 7, html_url: key, state: action === 'closed' ? 'closed' : 'open', ...(reason ? { state_reason: reason } : {}) }, repository: { full_name: REPO },
    });
    expect((await deliver(a, { body: closed('closed', 'completed'), secret, id: 'c-1' })).status).toBe(202);
    expect(store.workItems.get(key)).toMatchObject({ state: 'done', issueState: 'closed', issueReason: 'completed' });
    expect((await a.events('types=work_item.issue_closed')).map((e) => e.data)).toEqual([{ key, reason: 'completed', via: 'delivery' }]);

    expect((await deliver(a, { body: closed('reopened'), secret, id: 'c-2' })).status).toBe(202);
    expect(store.workItems.get(key)).toMatchObject({ state: 'failed', issueState: 'open' });
    // The same state again, or an issue that is no work item: nothing recorded.
    expect((await deliver(a, { body: closed('reopened'), secret, id: 'c-3' })).status).toBe(202);
    const other = { ...closed('closed', 'completed'), issue: { number: 8, html_url: `https://github.com/${REPO}/issues/8`, state: 'closed', state_reason: 'completed' } };
    expect((await deliver(a, { body: other, secret, id: 'c-4' })).status).toBe(202);
    expect(await a.events('types=work_item.issue_reopened')).toHaveLength(1);
    expect(await a.events('types=work_item.issue_closed')).toHaveLength(1);
  });

  it('a form-encoded delivery is refused with what to set', async () => {
    const { a, token } = await boot();
    const secret = (await a.ui<{ generatedSecret: string }>('/ui/api/github-deliveries', { action: 'make' }, { token })).body.generatedSecret;
    const r = await deliver(a, { body: labelled(), secret, contentType: 'application/x-www-form-urlencoded' });
    expect(r.status).toBe(415);
    expect(r.text).toContain('application/json');
  });

  it('rotate: the old secret is refused, the new one taken; remove: nothing is taken', async () => {
    const { a, token, told } = await boot();
    const first = (await a.ui<{ generatedSecret: string }>('/ui/api/github-deliveries', { action: 'make' }, { token })).body.generatedSecret;
    const second = (await a.ui<{ generatedSecret: string }>('/ui/api/github-deliveries', { action: 'make' }, { token })).body.generatedSecret;
    expect(second).not.toBe(first);
    expect((await deliver(a, { body: labelled(), secret: first, id: 'r-1' })).status).toBe(401);
    expect((await deliver(a, { body: labelled(), secret: second, id: 'r-2' })).status).toBe(202);
    const removed = await a.ui<{ secret: { set: boolean } }>('/ui/api/github-deliveries', { action: 'remove' }, { token });
    expect(removed.body.secret.set).toBe(false);
    expect((await deliver(a, { body: labelled(), secret: second, id: 'r-3' })).status).toBe(404);
    expect(told).toEqual([REPO]);
  });

  it('only the hopper\'s admin makes or removes the secret', async () => {
    const { a } = await boot();
    const other = await a.addUser('someone');
    const token = await a.login(other.id);
    expect((await a.ui('/ui/api/github-deliveries', { action: 'make' }, { token })).status).toBe(403);
  });
});
