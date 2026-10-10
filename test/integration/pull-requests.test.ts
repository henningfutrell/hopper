// The Pull requests list (issue #637): every hopper pull request that waits — a done job's, followed after its end
// (PR waiting) — grouped per repository, each with its state and its repository's yolo mode, and the header: how much
// yolo mode is on, and where merging waits. With yolo mode on, the hopper merges a ready pull request itself (checks
// pass, no merge conflicts) and its card drops off; a merge that waits or fails never fails the job and makes no failure
// record: the pull request only stays in the list. Off, it waits for a person. The same list and the per-repository
// toggle from the operator CLI. Real daemon, real database, real CLI; the in-memory fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { FailuresView, Job, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const OTHER = 'owner/other';
const THIRD = 'owner/third';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

async function boot(gh: FakeGitHub, repos = [REPO, OTHER]): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  connectGitHub(a, repos);
  return a;
}

async function hopper(app: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(app.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', app.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const list = async (app: TestApp): Promise<PullRequestsView> => (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body;
const cardOf = async (app: TestApp, jobId: string) => (await list(app)).repos.flatMap((r) => r.pullRequests).find((p) => p.jobId === jobId);
const failuresOf = async (app: TestApp): Promise<FailuresView> => (await app.api<FailuresView>('GET', '/api/failures')).body;
const now = () => new Date().toISOString();

/** A job of `repo` that ends done with its pull request open, as `pr` opens it; answers the job, finished, and the URL. */
async function waiting(gh: FakeGitHub, app: TestApp, repo: string, pr: { checks?: 'passing' | 'pending' | 'failing'; isDraft?: boolean } = {}) {
  const issue = gh.createIssue({ repo, body: body({ op: 'echo' }), labels: ['hopper'] });
  let url = '';
  app.scripted.ships((job) => { if (job.source?.key === issue.url) url = gh.openPullRequest(repo, issue.number, { createdAt: now(), ...pr }).url; });
  await app.sync();
  const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
  await waitFor(() => gh.issue(repo, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { issue, job, url };
}

describe('the Pull requests list and yolo mode (issue #637)', () => {
  it('test 10 — yolo on: the hopper merges a ready pull request and its card drops off; yolo off: the card waits for a person', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);

    const off = await waiting(gh, app, OTHER, { checks: 'passing' });
    const on = await waiting(gh, app, REPO, { checks: 'passing' });
    await app.sync();
    await waitFor(() => gh.issue(REPO, on.issue.number).state === 'closed', { what: 'the yolo pull request merged' });
    const merged = await waitFor(async () => (await app.events('types=job.pull_request_merged')).find((e) => e.jobId === on.job.id), { what: 'job.pull_request_merged' });
    expect(merged.data).toEqual({ pullRequest: on.url, part: false, byHopper: true });
    await app.sync();
    await waitFor(() => gh.issue(REPO, on.issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(await cardOf(app, on.job.id)).toBeUndefined();
    expect(gh.calls.filter((c) => c.method === 'merge').map((c) => c.args)).toEqual([[REPO, Number(on.url.split('/').at(-1))]]);

    // Yolo off: the card stays, waiting for a person; the hopper merges nothing.
    expect(await cardOf(app, off.job.id)).toMatchObject({ repo: OTHER, state: 'open', yolo: false, waits: 'yolo off', pullRequest: { url: off.url } });
    expect(gh.issue(OTHER, off.issue.number).state).toBe('open');
    expect((await app.job(on.job.id)).status).toBe('finished');
  });

  it('yolo on, a pull request with no checks is not merged (issue #652): its card waits on "no checks" until a check passed', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    await app.ui('/ui/api/yolo-mode', { on: true }, { token });
    const w = await waiting(gh, app, REPO);
    await app.sync();
    await waitFor(async () => (await cardOf(app, w.job.id))?.waits === 'no checks', { what: 'waits on a check' });
    expect(gh.calls.some((c) => c.method === 'merge')).toBe(false);
    expect(gh.issue(REPO, w.issue.number).state).toBe('open');

    gh.setChecks(w.url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, w.issue.number).state === 'closed', { what: 'merged once a check passed' });
  });

  it('test 9 — yolo on, the merge waits or fails: the job stays done, no failure record, the pull request stays in the list', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    await app.ui('/ui/api/yolo-mode', { on: true }, { token });
    const w = await waiting(gh, app, REPO, { checks: 'pending' });
    await app.sync();
    await waitFor(async () => (await cardOf(app, w.job.id))?.waits === 'checks pending', { what: 'waits on its checks' });
    expect(gh.calls.some((c) => c.method === 'merge')).toBe(false);

    // Checks pass, but GitHub refuses the merge: it stays, with what GitHub said.
    gh.setChecks(w.url, 'passing');
    gh.failNext('merge', new GitHubApiError('Pull Request is not mergeable (HTTP 405)', true, 405));
    await app.sync();
    const refused = await waitFor(async () => { const c = await cardOf(app, w.job.id); return c?.waits === 'merge refused' ? c : undefined; }, { what: 'the merge refused' });
    expect(refused).toMatchObject({ state: 'open', checks: 'passing', mergeError: expect.stringContaining('not mergeable') });

    // Merge conflicts after done: it waits on them; never a merge, never a failure.
    gh.pushToPullRequest(w.url, now(), { conflicting: true });
    await app.sync();
    await waitFor(async () => (await cardOf(app, w.job.id))?.waits === 'conflicts', { what: 'waits on its conflicts' });
    expect((await cardOf(app, w.job.id))!.mergeable).toBe('conflicts');
    expect(gh.calls.filter((c) => c.method === 'merge')).toHaveLength(1);
    expect((await app.job(w.job.id)).status).toBe('finished');
    expect((await failuresOf(app)).recent.filter((r) => r.jobId === w.job.id)).toEqual([]);
    expect(await app.events('types=job.failed')).toEqual([]);
  });

  it('test 11 — each card has its state and its repository\'s yolo badge; the header says how much yolo is on and where merging waits; the CLI answers the same', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh, [REPO, OTHER, THIRD]);
    const token = await app.login();
    await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true, [THIRD]: true } }, { token });
    const pending = await waiting(gh, app, REPO, { checks: 'pending' });
    const off1 = await waiting(gh, app, OTHER, { checks: 'passing' });
    const off2 = await waiting(gh, app, OTHER, { checks: 'passing' });
    const shut = await waiting(gh, app, THIRD, { checks: 'pending' });
    gh.closePullRequest(shut.url);
    await app.sync();
    await waitFor(() => gh.issue(THIRD, shut.issue.number).labels.includes('hopper:pr-closed'), { what: 'hopper:pr-closed' });
    await app.sync();

    const v = await waitFor(async () => { const x = await list(app); return x.repos.find((r) => r.repo === REPO)?.pullRequests[0]?.checks === 'pending' ? x : undefined; }, { what: 'checks seen' });
    expect(v.yolo).toEqual({ on: 2, total: 3 });
    expect(v.waiting).toEqual([{ repo: OTHER, count: 2, reason: 'yolo off' }, { repo: REPO, count: 1, reason: 'checks pending' }]);
    expect(v.repos.map((r) => [r.repo, r.yolo, r.pullRequests.map((p) => [p.jobId, p.state, p.yolo])])).toEqual([
      [REPO, true, [[pending.job.id, 'open', true]]],
      [OTHER, false, [[off1.job.id, 'open', false], [off2.job.id, 'open', false]]],
      [THIRD, true, [[shut.job.id, 'closed', true]]],
    ]);
    const card = v.repos[0]!.pullRequests[0]!;
    expect(card).toMatchObject({
      repo: REPO, issue: { number: pending.issue.number, url: pending.issue.url }, pullRequest: { url: pending.url, number: Number(pending.url.split('/').at(-1)) },
      part: false, checks: 'pending', mergeable: 'mergeable', draft: false, waits: 'checks pending',
    });
    expect(Date.parse(card.openedAt!)).not.toBeNaN();

    const cli = await hopper(app, ['prs', '--json']);
    expect(cli.code).toBe(0);
    expect(JSON.parse(cli.out)).toEqual(v);

    // The per-repository toggle from the CLI: yolo on for OTHER, and its ready pull requests merge.
    const set = await hopper(app, ['yolo', OTHER, 'on', '--json']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({ repos: { [OTHER]: true } });
    await app.sync();
    await waitFor(() => gh.issue(OTHER, off1.issue.number).state === 'closed' && gh.issue(OTHER, off2.issue.number).state === 'closed', { what: 'merged once yolo is on' });
    const [changed] = (await app.events('types=yolo_mode.changed')).slice(-1);
    expect(changed!.data.by).toBe('operator CLI');
    expect((await hopper(app, ['yolo', OTHER, 'maybe'])).code).toBe(2);
  });
});
