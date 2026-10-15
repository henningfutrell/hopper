// A hand-off's resolution goes back to its GitHub issue (issue #551): one short comment saying what was done, with the
// note and the link, and the labels set so the issue never stays `hopper:failed` once a person resolved it — done by
// hand `hopper:done`, won't do `hopper:rejected`, continued or run again back in the hopper's hands. The comment names
// no person. A write GitHub refused is tried again. Real daemon, in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { FailuresView, HandoffView, Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError, type GitHubApi } from '../../src/sources/github/api.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { connectGitHub } from '../support/github-account.ts';
import { resolveHandoff } from '../support/give-back.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: GitHubApi, dbPath?: string) {
  if (!dbPath) {
    const db = tempDbPath();
    cleanup = db.cleanup;
    dbPath = db.dbPath;
  }
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;

async function failedIssue(a: TestApp, gh: FakeGitHub) {
  const issue = gh.createIssue({ repo: REPO, body: '{"op":"fail","message":"HOPPER_FAILED the tests do not pass"}', labels: ['hopper'] });
  await a.sync();
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
  const job = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
  const h = await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.jobId === job.id && x.status === 'open'), { what: 'handed off' });
  return { issue, job, h };
}

// Continue answers before the give-back (issue #1194): the hand-off and its job once it is closed.
const resolve = (a: TestApp, token: string, h: HandoffView, body: Record<string, unknown>) => resolveHandoff(a, h.id, body, token);

describe('a resolution is written back to its GitHub issue', () => {
  it('Done by hand: hopper:done replaces hopper:failed, and a comment says so with the note and the link', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, h } = await failedIssue(a, gh);
    const r = await resolve(a, token, h, { action: 'done_by_hand', note: 'Merged the fix by hand.', link: 'https://github.com/owner/hopper-sandbox/pull/12' });
    expect(r.status).toBe(200);
    await waitFor(() => gh.commentsOn(REPO, issue.number).length === 1, { what: 'the comment' });
    const labels = gh.issue(REPO, issue.number).labels;
    expect(labels).toContain('hopper:done');
    expect(labels).not.toContain('hopper:failed');
    const [comment] = gh.commentsOn(REPO, issue.number);
    expect(comment!.body).toMatch(/done by hand/i);
    expect(comment!.body).toContain('Merged the fix by hand.');
    expect(comment!.body).toContain('https://github.com/owner/hopper-sandbox/pull/12');
    // It names no person: not the account, not the one who resolved it.
    expect(comment!.body).not.toMatch(/owner\b(?!\/)/);
    await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.id === h.id)?.resolution?.writeBack === 'written', { what: 'written' });
  });

  it('Won\'t do: hopper:rejected replaces hopper:failed, so the issue is not taken again, with the reason', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, h } = await failedIssue(a, gh);
    expect((await resolve(a, token, h, { action: 'wont_do', note: 'A duplicate of another issue.' })).status).toBe(200);
    await waitFor(() => gh.commentsOn(REPO, issue.number).length === 1, { what: 'the comment' });
    expect(gh.issue(REPO, issue.number).labels).toEqual(expect.arrayContaining(['hopper:rejected']));
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:failed');
    expect(gh.commentsOn(REPO, issue.number)[0]!.body).toContain('A duplicate of another issue.');
    // Not taken again by the next sync.
    await a.sync();
    expect((await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url)).toHaveLength(1);
  });

  it('Continue: hopper:failed goes, the follow-up runs, and a comment says it went on with a note', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, job, h } = await failedIssue(a, gh);
    const r = await resolve(a, token, h, { action: 'continue', note: 'Use the other test runner.' });
    expect(r.status).toBe(200);
    expect(r.body.job!.id).not.toBe(job.id);
    await waitFor(() => gh.commentsOn(REPO, issue.number).length === 1, { what: 'the comment' });
    expect(gh.commentsOn(REPO, issue.number)[0]!.body).toContain('Use the other test runner.');
    expect(gh.calls).toContainEqual(expect.objectContaining({ method: 'removeLabels', args: [REPO, issue.number, expect.arrayContaining(['hopper:failed'])] }));
  });

  it('a write GitHub refused is tried again, and the card says it is not written yet', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, h } = await failedIssue(a, gh);
    gh.failNext('postComment', new GitHubApiError('gh: HTTP 502', false, 502));
    expect((await resolve(a, token, h, { action: 'wont_do', note: 'Not wanted any more.' })).status).toBe(200);
    const pending = await waitFor(async () => {
      const x = (await failuresOf(a)).handoffs.find((y) => y.id === h.id);
      return x?.resolution?.writeBack === 'pending' && x.resolution.writeBackError ? x : undefined;
    }, { what: 'pending with the error' });
    expect(pending.resolution!.writeBackError).toContain('502');
    // The GitHub outbox sends it again after its backoff (issue #1238).
    await waitFor(() => gh.commentsOn(REPO, issue.number).length === 1, { what: 'written on a later try', timeoutMs: 15_000 });
    await waitFor(async () => (await failuresOf(a)).handoffs.find((x) => x.id === h.id)?.resolution?.writeBack === 'written', { what: 'written', timeoutMs: 15_000 });
  }, 40_000);

  it('a resolution is kept in the GitHub outbox: with GitHub\'s writes held it answers, and a restart sends its comment once (issue #1238)', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const gh = createFakeGitHub();
    let hold = false;
    const sent: string[] = [];
    const held = new Proxy(gh, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (typeof v !== 'function' || !['postComment', 'addLabels', 'removeLabels'].includes(String(prop))) return v;
        return (...args: unknown[]) => {
          if (!hold) return (v as (...x: unknown[]) => unknown).apply(target, args);
          sent.push(String(prop));
          return new Promise<never>(() => {});
        };
      },
    });
    const a = await boot(held, db.dbPath);
    const token = await a.login();
    const { issue, h } = await failedIssue(a, gh);
    hold = true;
    expect((await resolve(a, token, h, { action: 'wont_do', note: 'Not wanted any more.' })).status).toBe(200);
    await waitFor(() => sent.length > 0, { what: 'a write sent' });
    await a.sync();
    expect((await failuresOf(a)).handoffs.find((x) => x.id === h.id)?.resolution?.writeBack).toBe('pending');
    await a.stop();
    apps.splice(0);
    expect(gh.commentsOn(REPO, issue.number)).toEqual([]);

    const again = await boot(gh, db.dbPath);
    await waitFor(() => gh.commentsOn(REPO, issue.number).length === 1, { what: 'the comment after the restart', timeoutMs: 15_000 });
    expect(gh.issue(REPO, issue.number).labels).toContain('hopper:rejected');
    await again.sync();
    await waitFor(async () => (await failuresOf(again)).handoffs.find((x) => x.id === h.id)?.resolution?.writeBack === 'written', { what: 'written' });
    await again.sync();
    expect(gh.commentsOn(REPO, issue.number)).toHaveLength(1);
  }, 40_000);
});
