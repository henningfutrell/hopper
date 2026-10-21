// Issue #2342: one click on a tagged item starts a job on it. The daemon, store and HTTP edge are real; GitHub is the
// in-memory fake at its seam.
//
// Feature: Research, Propose and Start work on Tagged
//   Scenario: Research on a pull request starts a research job; a second click starts nothing
//     Given a pull request that asks for the user's review is tagged
//     When the person clicks Research
//     Then a direct job made from the item is queued as a research job, with no repository to open a pull request on
//     And the item shows the job it started, after a restart too
//     And a second click answers the first start, and no second direct job is made
//   Scenario: Start work fixes an issue on its repository; a pull request is reviewed, or worked on its branch when picked
//     And Propose asks for a proposal
//   Scenario: an item the last sync did not list, or a work kind on Research, is refused, and nothing is made
import { afterEach, describe, expect, it } from 'vitest';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';
import type { TaggedItem } from '../../src/domain/tagged.ts';
import type { TaggedSearchHit } from '../../src/sources/github/api.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const hit = (n: number, kind: 'pull' | 'issue', why: TaggedSearchHit['why']): TaggedSearchHit => ({
  key: `https://github.com/${REPO}/${kind === 'pull' ? 'pull' : 'issues'}/${n}`, repo: REPO, number: n, kind, title: `Item ${n}`, author: 'someone', why,
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: `2026-10-14T0${n}:00:00.000Z`, labels: [], ...(kind === 'pull' ? { checks: 'passing' as const, isDraft: false } : {}),
});

async function start(hits: TaggedSearchHit[], dbPath?: string) {
  const gh = createFakeGitHub();
  gh.taggedItems = async () => hits;
  const db = dbPath ? { dbPath, cleanup: () => {} } : tempDbPath();
  if (!dbPath) cleanups.push(db.cleanup);
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const app = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(app);
  connectGitHub(app, [REPO]);
  const token = await app.login();
  await app.sync();
  return { app, token, dbPath: db.dbPath };
}

const tagged = async (a: TestApp): Promise<TaggedItem[]> =>
  (await a.api<{ sources: { name: string; detail: { tagged?: TaggedItem[] } }[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === 'github')!.detail.tagged ?? [];
const directJobs = async (a: TestApp): Promise<DirectJobView[]> => (await a.api<{ directJobs: DirectJobView[] }>('GET', '/api/direct-jobs')).body.directJobs;

describe('Research, Propose and Start work on Tagged (issue #2342)', () => {
  it('Research on a pull request starts a research job once, and the item shows it', { timeout: 60_000 }, async () => {
    const pr = hit(1, 'pull', 'review');
    const { app, token, dbPath } = await start([pr]);
    const r = await app.ui<{ started: { directJob: string; jobId: string; start: string }; directJob: DirectJobView; job: { id: string; source: { labels: string[] } } }>(
      '/ui/api/sources/github/tagged-start', { key: pr.key, start: 'research' }, { token });
    expect(r.status).toBe(200);
    expect(r.body.started).toMatchObject({ start: 'research', directJob: r.body.directJob.id, jobId: r.body.job.id });
    expect(r.body.directJob).toMatchObject({ title: `Research: ${REPO}#1 Item 1`, labels: ['hopper:research'], authorizations: [], submittedBy: { via: 'ui' } });
    expect(r.body.directJob.repo).toBeUndefined();
    const job = await app.job(r.body.job.id);
    expect(job.spec.research).toBe(true);
    expect((job.spec.payload as { prompt: string }).prompt).toContain(`item: ${pr.key}`);

    const again = await app.ui<{ started: { directJob: string }; replayed: boolean }>('/ui/api/sources/github/tagged-start', { key: pr.key, start: 'work' }, { token });
    expect(again).toMatchObject({ status: 200, body: { replayed: true, started: { directJob: r.body.directJob.id } } });
    expect(await directJobs(app)).toHaveLength(1);

    await app.sync();
    expect((await tagged(app))[0]!.started).toMatchObject({ start: 'research', directJob: r.body.directJob.id, jobId: r.body.job.id });
    await app.stop();
    apps.splice(apps.indexOf(app), 1);
    const back = await start([pr], dbPath);
    expect((await tagged(back.app))[0]!.started).toMatchObject({ directJob: r.body.directJob.id });
  });

  it('Start work fixes an issue on its repository; a pull request is reviewed, or worked on its branch when picked; Propose asks for a proposal', { timeout: 60_000 }, async () => {
    const issue = hit(2, 'issue', 'assign');
    const review = hit(3, 'pull', 'review');
    const branch = hit(4, 'pull', 'assign');
    const idea = hit(5, 'issue', 'mention');
    const { app, token } = await start([issue, review, branch, idea]);
    const go = (key: string, more: Record<string, unknown> = {}) => app.ui<{ directJob: DirectJobView }>('/ui/api/sources/github/tagged-start', { key, start: 'work', ...more }, { token });
    const fix = (await go(issue.key)).body.directJob;
    expect(fix).toMatchObject({ title: `Work on: ${REPO}#2 Item 2`, labels: [], repo: REPO });
    expect(fix.brief).toContain('"Closes #2"');
    const reviewed = (await go(review.key)).body.directJob;
    expect(reviewed).toMatchObject({ title: `Review: ${REPO}#3 Item 3`, labels: [] });
    expect(reviewed.repo).toBeUndefined();
    const onBranch = (await go(branch.key, { work: 'fix' })).body.directJob;
    expect(onBranch).toMatchObject({ title: `Work on: ${REPO}#4 Item 4`, repo: REPO });
    const propose = await app.ui<{ directJob: DirectJobView }>('/ui/api/sources/github/tagged-start', { key: idea.key, start: 'propose' }, { token });
    expect(propose.body.directJob).toMatchObject({ title: `Proposal: ${REPO}#5 Item 5`, labels: ['hopper:proposal'] });
  });

  it('refuses an item the last sync did not list, and a work kind on Research; nothing is made', { timeout: 60_000 }, async () => {
    const pr = hit(1, 'pull', 'review');
    const { app, token } = await start([pr]);
    expect((await app.ui('/ui/api/sources/github/tagged-start', { key: `https://github.com/${REPO}/pull/9`, start: 'research' }, { token })).status).toBe(404);
    expect((await app.ui('/ui/api/sources/nope/tagged-start', { key: pr.key, start: 'research' }, { token })).status).toBe(404);
    expect((await app.ui('/ui/api/sources/github/tagged-start', { key: pr.key, start: 'research', work: 'fix' }, { token })).status).toBe(400);
    expect(await directJobs(app)).toEqual([]);
  });
});
