// The tending queue (issue #796): when several waiting pull requests of one job repository need tending at once, the
// hopper tends one at a time, in a decided order. The head is rebased and, with yolo mode on, merged before the next is
// rebased against the new base: one rebase per merge, never a rebase of the whole backlog that each merge breaks again.
// Jev picks the head first (`merge-order`); in shadow its pick is compared with the rules' head. One queue per set of pull
// requests that conflict (issue #939): pull requests git says do not conflict are tended at the same time, and of two ready
// ones that conflict the hopper merges one per sync pass. Real daemon, in-memory fake GitHub at the GitHubApi seam (its git
// answer set by the test), Jev as a double at its seam; issues carry a scripted-executor op as their first body line.
import { afterEach, describe, expect, it } from 'vitest';
import type { JevChooser, JevPick, Job, MinorDecisionAsk, PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const OTHER = 'owner/other-sandbox';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

/** Jev as a double: picks what `answer` says, records every ask. */
function fakeJev(answer: (ask: MinorDecisionAsk) => JevPick | undefined): JevChooser & { asks: MinorDecisionAsk[] } {
  const asks: MinorDecisionAsk[] = [];
  return {
    asks,
    available: () => ({ available: true }),
    pick: async (ask) => { asks.push(ask); return answer(ask) ?? { ok: false, why: 'not this point' }; },
    choose: async () => ({ ok: false, why: 'no risk call here' }),
    check: async () => ({ ok: true }),
  };
}

async function boot(gh: FakeGitHub, jev?: JevChooser): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh, ...(jev ? { jev } : {}) }, plugins });
  connectGitHub(a, [REPO, OTHER]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const sourceOf = (j: Job) => j.sourceState?.source as { follow?: string; heldBehind?: unknown; seen?: { mergeHeldBehind?: string } } | undefined;

const urlsOf = new WeakMap<TestApp, Map<string, string>>();

interface Waiting { issue: number; job: Job; url: string }

/**
 * `count` issues of `repo`, each a job that opens a ready pull request (the first the oldest), with `checks`; each later run
 * of an item — a tend — does `tend` to its pull request.
 */
async function waitingPullRequests(gh: FakeGitHub, app: TestApp, repo: string, count: number, o: { checks?: 'passing'; tend?: (url: string) => void } = {}): Promise<Waiting[]> {
  // One map per app: a later call's handler tends the pull requests of an earlier call too.
  const urls = urlsOf.get(app) ?? urlsOf.set(app, new Map()).get(app)!;
  const tend = o.tend ?? ((url: string) => gh.pushToPullRequest(url, new Date().toISOString()));
  app.scripted.ships((j) => {
    const n = j.source!.number!;
    const at = urls.get(j.source!.key);
    if (at === undefined) urls.set(j.source!.key, gh.openPullRequest(j.source!.repo!, n, { createdAt: ago(10 * (count - n + 1)), ...(o.checks ? { checks: o.checks } : {}) }).url);
    else tend(at);
  });
  const issues = Array.from({ length: count }, () => gh.createIssue({ repo, body: body({ op: 'echo' }), labels: ['hopper'] }));
  await app.sync();
  const out: Waiting[] = [];
  for (const issue of issues) {
    const job = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(repo, issue.number).labels.includes('hopper:pr-ready'), { what: `hopper:pr-ready on #${issue.number}` });
    out.push({ issue: issue.number, job, url: urls.get(issue.url)! });
  }
  return out;
}

const tends = async (app: TestApp) => (await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, (e.data as { step: string }).step]);
const nextJobOf = async (app: TestApp, jobId: string): Promise<string> =>
  ((await app.events('types=job.pull_request_tended')).find((e) => e.jobId === jobId)!.data as { nextJobId: string }).nextJobId;

/** The tend job of `jobId` finished, and follows its pull request again. */
async function tendDone(app: TestApp, jobId: string): Promise<void> {
  const next = await nextJobOf(app, jobId);
  await app.waitForStatus(next, 'finished');
  await waitFor(async () => sourceOf(await app.job(next))?.follow === 'open', { what: 'the tend job follows its pull request' });
}

describe('the tending queue (issue #796)', () => {
  it('yolo off: one pull request of a repository is tended at a time, the oldest first; the next once the tend is done', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [first, second, third] = await waitingPullRequests(gh, app, REPO, 3);
    for (const w of [first!, second!, third!]) gh.setConflicting(w.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase']]);
    await tendDone(app, first!.job.id);
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase'], [second!.job.id, 'rebase']]);
    await tendDone(app, second!.job.id);
    await app.sync();
    expect((await tends(app)).map(([id]) => id)).toEqual([first!.job.id, second!.job.id, third!.job.id]);
    await tendDone(app, third!.job.id);
  });

  it('yolo on: the head is rebased and merged before the next is rebased against the new base', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    // A tend pushes, and the pull request's checks run again.
    const [first, second] = await waitingPullRequests(gh, app, REPO, 2, {
      checks: 'passing', tend: (url) => { gh.pushToPullRequest(url, new Date().toISOString()); gh.setChecks(url, 'pending'); },
    });
    gh.setConflicting(first!.url, true);
    gh.setConflicting(second!.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase']]);
    await tendDone(app, first!.job.id);
    // The head waits for its checks, on its way to the merge: the next is not rebased yet.
    await app.sync();
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase']]);
    expect(gh.calls.some((c) => c.method === 'merge')).toBe(false);
    // Its checks pass: the hopper merges it, and only then is the next one rebased.
    gh.setChecks(first!.url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, first!.issue).state === 'closed', { what: 'the head merged' });
    await waitFor(async () => (await tends(app)).length === 2, { what: 'the next one tended' });
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase'], [second!.job.id, 'rebase']]);
    await tendDone(app, second!.job.id);
  });

  it('each repository has its own queue', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [mine] = await waitingPullRequests(gh, app, REPO, 1);
    const [other] = await waitingPullRequests(gh, app, OTHER, 1);
    gh.setConflicting(mine!.url, true);
    gh.setConflicting(other!.url, true);
    await app.sync();
    expect((await tends(app)).map(([id]) => id).sort()).toEqual([mine!.job.id, other!.job.id].sort());
    await tendDone(app, mine!.job.id);
    await tendDone(app, other!.job.id);
  });
});

describe('one queue per set of pull requests that conflict (issue #939)', () => {
  it('pull requests that do not conflict are tended at the same time; one that conflicts with a tend waits for it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [first, second, third] = await waitingPullRequests(gh, app, REPO, 3);
    gh.setConflictBetween(first!.url, second!.url, false);
    gh.setConflictBetween(first!.url, third!.url, true);
    gh.setConflictBetween(second!.url, third!.url, false);
    for (const w of [first!, second!, third!]) gh.setConflicting(w.url, true);
    await app.sync();
    expect((await tends(app)).map(([id]) => id).sort()).toEqual([first!.job.id, second!.job.id].sort());
    expect(sourceOf(await app.job(third!.job.id))?.heldBehind).toEqual({ pullRequest: first!.url, why: 'tending' });
    const cards = (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.find((r) => r.repo === REPO)!.pullRequests;
    expect(cards.find((c) => c.jobId === third!.job.id)?.queue).toEqual({ held: { pullRequest: Number(first!.url.split('/').at(-1)), why: 'tending' } });
    await tendDone(app, first!.job.id);
    await tendDone(app, second!.job.id);
    await app.sync();
    expect((await tends(app)).map(([id]) => id)).toContain(third!.job.id);
    expect(sourceOf(await app.job(third!.job.id))?.heldBehind).toBeUndefined();
    await tendDone(app, third!.job.id);
  });

  it('git cannot say: one tend at a time, as before', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [first, second] = await waitingPullRequests(gh, app, REPO, 2);
    for (const w of [first!, second!]) gh.setConflicting(w.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase']]);
    expect(sourceOf(await app.job(second!.job.id))?.heldBehind).toEqual({ pullRequest: first!.url, why: 'tending' });
    await tendDone(app, first!.job.id);
  });

  it('yolo on: of two ready pull requests that conflict, one is merged; the other is held, then tended against the new base at once', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    const waiting = await waitingPullRequests(gh, app, REPO, 2, { checks: 'passing' });
    gh.setConflictBetween(waiting[0]!.url, waiting[1]!.url, true);
    await app.sync();
    const merged = await waitFor(() => waiting.find((w) => gh.issue(REPO, w.issue).state === 'closed'), { what: 'one merged' });
    const held = waiting.find((w) => w !== merged)!;
    // The merge moved the base: the held one has merge conflicts now. The sync that runs at once after a merge (issue #967)
    // tends it, with no sync asked for.
    await waitFor(async () => (await tends(app)).some(([id]) => id === held.job.id), { what: 'the held one tended' });
    expect(gh.calls.filter((c) => c.method === 'merge')).toHaveLength(1);
    await tendDone(app, held.job.id);
  });
});

describe('rework goes back at once (issue #938)', () => {
  /** A tend pushes, and its pull request's checks pass. */
  const fixed = (gh: FakeGitHub) => (url: string) => { gh.pushToPullRequest(url, new Date().toISOString()); gh.setChecks(url, 'passing'); };

  it('pull requests with failed checks are all sent back in the same sync, held by no head, beside the rebase the queue starts', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    // Git cannot say whether they conflict: before, one tend at a time.
    const [first, second, third] = await waitingPullRequests(gh, app, REPO, 3, { tend: fixed(gh) });
    gh.setConflicting(first!.url, true);
    gh.setChecks(second!.url, 'failing');
    gh.setChecks(third!.url, 'failing');
    await app.sync();
    expect((await tends(app)).sort()).toEqual([[first!.job.id, 'rebase'], [second!.job.id, 'fix_checks'], [third!.job.id, 'fix_checks']].sort());
    for (const w of [second!, third!]) expect(sourceOf(await app.job(w.job.id))?.heldBehind).toBeUndefined();
    for (const w of [first!, second!, third!]) await tendDone(app, w.job.id);
  });

  it('yolo on: a pull request with failed checks is sent back while a pull request that conflicts with it waits for its checks', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    const [head, failing] = await waitingPullRequests(gh, app, REPO, 2, { checks: 'passing', tend: fixed(gh) });
    gh.setConflictBetween(head!.url, failing!.url, true);
    gh.pushToPullRequest(head!.url, new Date().toISOString());
    gh.setChecks(head!.url, 'pending');
    gh.setChecks(failing!.url, 'failing');
    await app.sync();
    expect(await tends(app)).toEqual([[failing!.job.id, 'fix_checks']]);
    expect(sourceOf(await app.job(failing!.job.id))?.heldBehind).toBeUndefined();
    await tendDone(app, failing!.job.id);
  });
});

describe('merge-order: Jev picks the head of the tending queue (issue #796)', () => {
  it('active: a sure pick is tended first', async () => {
    const gh = createFakeGitHub();
    let newest = '';
    const jev = fakeJev((ask) => (ask.point === 'merge-order' ? { ok: true, pick: newest, confidence: 0.95 } : undefined));
    const app = await boot(gh, jev);
    const token = await app.login();
    expect((await app.ui('/ui/api/minor-decisions/points/merge-order', { mode: 'active' }, { token })).status).toBe(200);
    const waiting = await waitingPullRequests(gh, app, REPO, 3);
    newest = waiting[2]!.job.id;
    for (const w of waiting) gh.setConflicting(w.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[newest, 'rebase']]);
    const ask = jev.asks.find((x) => x.point === 'merge-order')!;
    // The options in the rules' order: the oldest pull request first.
    expect(ask.options.map((o) => o.id)).toEqual(waiting.map((w) => w.job.id));
    const picked = (await app.events('types=minor_decision.picked')).find((e) => (e.data as { point: string }).point === 'merge-order')!;
    expect(picked.data).toMatchObject({ point: 'merge-order', pick: newest, applied: true });
    await tendDone(app, newest);
  });

  it('shadow: the rules\' head is tended, and Jev\'s pick is compared with it', async () => {
    const gh = createFakeGitHub();
    let newest = '';
    const jev = fakeJev((ask) => (ask.point === 'merge-order' ? { ok: true, pick: newest, confidence: 0.95 } : undefined));
    const app = await boot(gh, jev);
    const waiting = await waitingPullRequests(gh, app, REPO, 2);
    newest = waiting[1]!.job.id;
    for (const w of waiting) gh.setConflicting(w.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[waiting[0]!.job.id, 'rebase']]);
    const picked = (await app.events('types=minor_decision.picked')).find((e) => (e.data as { point: string }).point === 'merge-order')!;
    expect(picked.data).toMatchObject({ point: 'merge-order', pick: newest, applied: false, notApplied: 'shadow' });
    const compared = await waitFor(async () => (await app.events('types=minor_decision.compared')).find((e) => (e.data as { point: string }).point === 'merge-order'), { what: 'compared' });
    expect(compared.data).toMatchObject({ point: 'merge-order', pick: newest, actual: waiting[0]!.job.id, agreed: false, decidedBy: 'rules' });
    await tendDone(app, waiting[0]!.job.id);
  });

  it('one pull request to tend: Jev is not asked', async () => {
    const gh = createFakeGitHub();
    const jev = fakeJev(() => undefined);
    const app = await boot(gh, jev);
    const [only] = await waitingPullRequests(gh, app, REPO, 1);
    gh.setConflicting(only!.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[only!.job.id, 'rebase']]);
    expect(jev.asks.filter((x) => x.point === 'merge-order')).toEqual([]);
    await tendDone(app, only!.job.id);
  });
});

describe('intake-order: Jev picks which new item enters first (issue #796)', () => {
  /** Every job ended: none is still at work when the app stops. */
  const allEnded = (app: TestApp, count: number) => waitFor(async () => {
    const jobs = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
    return jobs.length === count && jobs.every((j) => ['finished', 'failed'].includes(j.status));
  }, { what: 'every job ended' });
  const queuedKeys = async (app: TestApp): Promise<string[]> => {
    const jobs = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
    return (await app.events('types=job.queued')).map((e) => jobs.find((j) => j.id === e.jobId)!.source!.key);
  };

  it('active: a sure pick enters first; the rest follow in the source\'s order', async () => {
    const gh = createFakeGitHub();
    const jev = fakeJev((ask) => (ask.point === 'intake-order' ? { ok: true, pick: ask.options.at(-1)!.id, confidence: 0.95 } : undefined));
    const app = await boot(gh, jev);
    const token = await app.login();
    expect((await app.ui('/ui/api/minor-decisions/points/intake-order', { mode: 'active' }, { token })).status).toBe(200);
    for (let i = 0; i < 3; i++) gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await app.sync();
    const ask = jev.asks.find((x) => x.point === 'intake-order')!;
    const rules = ask.options.map((o) => o.id);
    expect(rules).toHaveLength(3);
    expect(await queuedKeys(app)).toEqual([rules[2], rules[0], rules[1]]);
    await allEnded(app, 3);
  });

  it('shadow: the items enter in the source\'s order, and Jev\'s pick is compared with its first', async () => {
    const gh = createFakeGitHub();
    const jev = fakeJev((ask) => (ask.point === 'intake-order' ? { ok: true, pick: ask.options.at(-1)!.id, confidence: 0.95 } : undefined));
    const app = await boot(gh, jev);
    for (let i = 0; i < 2; i++) gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await app.sync();
    const rules = jev.asks.find((x) => x.point === 'intake-order')!.options.map((o) => o.id);
    expect(await queuedKeys(app)).toEqual(rules);
    const compared = await waitFor(async () => (await app.events('types=minor_decision.compared')).find((e) => (e.data as { point: string }).point === 'intake-order'), { what: 'compared' });
    expect(compared.data).toMatchObject({ point: 'intake-order', pick: rules[1], actual: rules[0], agreed: false, decidedBy: 'rules' });
    await allEnded(app, 2);
  });

  it('one new item: Jev is not asked', async () => {
    const gh = createFakeGitHub();
    const jev = fakeJev(() => undefined);
    const app = await boot(gh, jev);
    gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await app.sync();
    expect(jev.asks.filter((x) => x.point === 'intake-order')).toEqual([]);
    await allEnded(app, 1);
  });
});
