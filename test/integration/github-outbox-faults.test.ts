// The GitHub outbox under GitHub's faults (issue #1959), through the real daemon and the connected account's real adapter
// against the node:http fake GitHub: a 5xx is tried again after its backoff; a secondary rate limit with Retry-After holds
// every call until then, and the storm drains with each write made once; a write GitHub applied whose answer never came
// (the connection cut, as a timeout) is sent again and makes nothing twice — the comment is found by its key; a row
// GitHub refused for good fails its item's later rows with it, in order, shows with Retry and holds no other item; and
// a person's action answers at once while GitHub holds the outbox's calls (issue #1194).
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { OutboxFailed } from '../../src/sources/github/outbox.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { TEST_ACCOUNT_TOKEN, connectGitHub, fakeGitHubEnv, githubSource } from '../support/github-account.ts';
import { withinBudget } from '../support/latency.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const path = (n: number, rest = '') => `/repos/${REPO}/issues/${n}${rest}`;

const apps: TestApp[] = [];
const servers: FakeGitHubServer[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const c of cleanups.splice(0)) c();
});

interface SourceDetail { intake?: IntakeOutcome[]; outboxFailed?: OutboxFailed[]; writeBehindPending?: number }

/** The daemon over the fake GitHub: #1 a request card a stranger wrote, #2 an issue with no assignee. */
async function boot() {
  const github = await createFakeGitHubServer({
    login: 'owner', token: TEST_ACCOUNT_TOKEN,
    installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], issues: [
      { number: 1, title: 'Fix the typo', author: 'stranger', assignees: ['owner'], labels: ['hopper'], body: 'Fix the typo in the README.' },
      { number: 2, title: 'Rename the flag', author: 'stranger', assignees: [], labels: ['hopper'], body: 'Rename the flag.' },
    ] }] }],
  });
  servers.push(github);
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { jobSources: [githubSource()] }, env: fakeGitHubEnv(github) });
  apps.push(a);
  connectGitHub(a, [REPO]);
  await a.sync();
  const token = await a.login();
  const detail = async (): Promise<SourceDetail> =>
    (await a.api<{ sources: { name: string; detail: SourceDetail }[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github')!.detail;
  const hash = (await detail()).intake?.find((x) => x.key === issueUrl(1))?.request?.hash;
  expect(hash).toBeDefined();
  const decline = () => a.ui('/ui/api/sources/github/intake', { kind: 'decline', keys: [issueUrl(1)], hash, choice: 'close' }, { token });
  const assign = () => a.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [issueUrl(2)] }, { token });
  const issue = (n: number) => github.state.repos.get(REPO)!.issues.get(n)!;
  const count = (method: string, p: string) => github.state.requests.filter((r) => r.method === method && r.path === p).length;
  const writes = () => github.state.requests.filter((r) => r.method !== 'GET' && r.path !== '/graphql').map((r) => `${r.method} ${r.path}`);
  return { a, github, token, detail, decline, assign, issue, count, writes };
}

/** Decline's effects on #1, each once: its label off, one comment with the outbox's key, closed as not planned. */
function declinedOnce(w: Awaited<ReturnType<typeof boot>>): void {
  const one = w.issue(1);
  expect(one.labels).not.toContain('hopper');
  expect(one.comments).toHaveLength(1);
  expect(one.comments[0]!.body).toMatch(/^<!-- job-hopper v1 kind=outbox id=[0-9a-f]{16} -->\n/);
  expect([one.state, one.stateReason]).toEqual(['closed', 'not_planned']);
}

const settled = (w: Awaited<ReturnType<typeof boot>>) => waitFor(async () => {
  const d = await w.detail();
  return d.writeBehindPending === undefined && w.issue(1).state === 'closed' && w.issue(2).assignees.includes('owner') ? true : undefined;
}, { timeoutMs: 40_000, what: 'every outbox row sent' });

describe('the GitHub outbox under GitHub\'s faults (issue #1959)', () => {
  it('a 5xx: the item shows the next attempt and why, the row goes after its backoff, each effect once', { timeout: 60_000 }, async () => {
    const w = await boot();
    w.github.fail(`POST ${path(2, '/assignees')}`, 502, 'Bad Gateway', 1);
    w.github.fail(`DELETE ${path(1, '/labels/hopper')}`, 503, 'Service Unavailable', 1);
    expect((await w.assign()).status).toBe(200);
    expect((await w.decline()).status).toBe(200);
    const marker = await waitFor(async () => (await w.detail()).intake?.find((x) => x.key === issueUrl(2) && x.writeBehind?.state === 'running' && x.writeBehind.attempt === 2)?.writeBehind, { what: 'the assignment waiting its backoff' });
    expect(marker).toMatchObject({ act: 'assign', state: 'running', attempt: 2, error: expect.stringContaining('Bad Gateway') });
    await settled(w);
    declinedOnce(w);
    expect(w.count('POST', path(1, '/comments'))).toBe(1);
    expect(w.issue(2).assignees).toEqual(['owner']);
    expect(w.count('POST', path(2, '/assignees'))).toBe(2);
  });

  it('a secondary rate limit with Retry-After: no call goes before it ends, and the storm drains with each write once', { timeout: 60_000 }, async () => {
    const w = await boot();
    const limited = 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
    w.github.fail(`POST ${path(1, '/comments')}`, 403, limited, 2, { 'retry-after': '3' });
    w.github.fail(`POST ${path(2, '/assignees')}`, 403, limited, 1, { 'retry-after': '3' });
    expect((await w.decline()).status).toBe(200);
    expect((await w.assign()).status).toBe(200);
    await waitFor(() => (w.count('POST', path(1, '/comments')) + w.count('POST', path(2, '/assignees')) > 0 ? true : undefined), { what: 'the first refusal' });
    const seen = w.github.state.requests.length;
    await new Promise((res) => setTimeout(res, 2_000));
    // The limiter holds every call of the account until GitHub's Retry-After: the fake hears nothing meanwhile.
    expect(w.github.state.requests.slice(seen)).toEqual([]);
    await settled(w);
    declinedOnce(w);
    expect(w.issue(2).assignees).toEqual(['owner']);
    // Two refusals and the post that went through; nothing posted twice.
    expect(w.count('POST', path(1, '/comments'))).toBe(3);
    expect(w.issue(1).comments).toHaveLength(1);
  });

  it('a write GitHub applied and never answered (a timeout): sent again, it makes nothing twice', { timeout: 60_000 }, async () => {
    const w = await boot();
    w.github.dropAfter(`POST ${path(1, '/comments')}`);
    w.github.dropAfter(`PATCH ${path(1)}`);
    w.github.dropAfter(`POST ${path(2, '/assignees')}`);
    expect((await w.decline()).status).toBe(200);
    expect((await w.assign()).status).toBe(200);
    await settled(w);
    const one = w.issue(1);
    expect(one.labels).not.toContain('hopper');
    expect(one.comments).toHaveLength(1);
    expect([one.state, one.stateReason]).toEqual(['closed', 'not_planned']);
    // The comment GitHub took is found by its key: the second send lists the comments and posts none.
    expect(w.count('POST', path(1, '/comments'))).toBe(1);
    expect(w.count('PATCH', path(1))).toBe(2);
    expect(w.issue(2).assignees).toEqual(['owner']);
    expect((await w.a.events('types=source.request_decline_written')).map((e) => e.data.key)).toEqual([issueUrl(1)]);
    expect((await w.a.events('types=source.issues_assigned')).map((e) => e.data.keys)).toEqual([[issueUrl(2)]]);
  });

  it('a row GitHub refused for good fails its item\'s later rows with it; it shows with Retry, the other item goes on, and Retry sends them in order', { timeout: 60_000 }, async () => {
    const w = await boot();
    w.github.fail(`DELETE ${path(1, '/labels/hopper')}`, 422, 'Validation Failed', 1);
    expect((await w.decline()).status).toBe(200);
    expect((await w.assign()).status).toBe(200);
    const failed = await waitFor(async () => (await w.detail()).outboxFailed?.find((f) => f.key === issueUrl(1)), { what: 'the decline failed' });
    expect(failed).toMatchObject({ act: 'decline', attempts: 1, error: expect.stringContaining('Validation Failed') });
    await waitFor(() => (w.issue(2).assignees.includes('owner') ? true : undefined), { what: 'the other item assigned' });
    // Nothing after the refused call went: no comment, no close.
    expect(w.count('POST', path(1, '/comments'))).toBe(0);
    expect(w.issue(1).state).toBe('open');

    const before = w.writes().length;
    expect((await w.a.ui('/ui/api/sources/github/intake', { kind: 'retry_outbox', keys: [issueUrl(1)] }, { token: w.token })).body).toMatchObject({ done: [issueUrl(1)] });
    await waitFor(() => (w.issue(1).state === 'closed' ? true : undefined), { what: 'the decline sent again', timeoutMs: 20_000 });
    declinedOnce(w);
    expect(w.writes().slice(before).filter((x) => x.includes('/issues/1'))).toEqual([
      `DELETE ${path(1, '/labels/hopper')}`, `POST ${path(1, '/comments')}`, `PATCH ${path(1)}`,
    ]);
    expect((await w.detail()).outboxFailed).toBeUndefined();
  });

  it('GitHub holds the outbox\'s calls: a person\'s actions still answer at once, and the rows go once it answers', { timeout: 60_000 }, async () => {
    const w = await boot();
    const held = w.github.hold(`DELETE ${path(1, '/labels/hopper')}`);
    expect((await w.decline()).status).toBe(200);
    await waitFor(() => (held.held() === 1 ? true : undefined), { what: 'the decline held at GitHub' });
    const t0 = performance.now();
    const r = await w.assign();
    withinBudget(performance.now() - t0);
    expect(r).toMatchObject({ status: 200, body: { done: [issueUrl(2)], failed: {} } });
    expect((await w.detail()).intake?.find((x) => x.key === issueUrl(2))?.writeBehind).toMatchObject({ act: 'assign', state: 'running' });
    held.release();
    await settled(w);
    declinedOnce(w);
    expect(w.count('POST', path(1, '/comments'))).toBe(1);
    expect(w.issue(2).assignees).toEqual(['owner']);
  });
});
