// Issue #435 on the GitHub watches of #427: a job parked on a question posted on its issue thread has a GitHub watch on
// its issue. When the watch sees a new comment, the thread pass reads the replies at once, so the job resumes with no
// sync of its source. A sync reads the thread again only when the watch cannot tell: it has no snapshot, it has a
// problem, or its snapshot holds a comment after the question's. The daemon, store and HTTP edge are real; the job source
// is the in-memory fake GitHub, and the watch reads a fake GitHub on loopback with the person's own connection. The two
// fakes hold the same comments, with the same ids.
//
// Feature: a reply on the issue thread, seen by the watch
//   Scenario: the watch sees the reply and the job resumes on its own
//     Given a job parked on its question, posted on its issue thread
//     Then its issue has a GitHub watch, and the watch's first snapshot holds the question comment
//     And a sync of the source does not read the thread again
//     When the owner replies on the issue, and the watch polls
//     Then the watch records the comment, on the job's timeline
//     And the job resumes its saved session with the reply, with no sync of its source
//     And the watch ends with the question
//   Scenario: a comment the watch saw that answers nothing keeps the sync reading
//     When a stranger comments after the question
//     Then each sync reads the thread, and the job stays parked
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent, type GitHubWatch, type GitHubWatchView, type Job, type Question } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeGitHub as createSourceGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeGitHub as createForge, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub, githubSource } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const ASK = { output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] };
const DONE = { output: ['● Painted the shed.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

interface World { a: TestApp; token: string; gh: FakeGitHub; forge: FakeForge; herdr: FakeHerdrClient }

async function boot(): Promise<World> {
  const forge = await createForge({ clientId: 'gh-client-id', issues: [] });
  cleanups.push(() => forge.close());
  forge.tokens.set('test-account-token', 'owner');
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
  const gh = createSourceGitHub();
  const a = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: forge.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    plugins: { executors: EXECUTORS, machines: lanes(1), jobSources: [githubSource({ executor: 'herdr-claude' })] },
    seams: { herdr, github: gh, levels: [] },
  });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return { a, token: await a.login(), gh, forge, herdr };
}

const jobOf = async (a: TestApp, url: string): Promise<Job> => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const questionOf = async (a: TestApp, jobId: string): Promise<Question> => (await a.questionsOf(jobId))[0]!;
const watches = async (a: TestApp): Promise<GitHubWatch[]> => (await a.api<GitHubWatchView>('GET', '/api/github-watches')).body.watches;
const changed = (a: TestApp): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'github_watch.changed');
const reads = (gh: FakeGitHub): number => gh.calls.filter((c) => c.method === 'listComments').length;

/** The forge's copy of the source fake's comments on the issue, ids kept, as GitHub's REST answers them. */
function mirror(w: World, number: number): void {
  const issue = w.forge.issues.find((i) => i.repo === REPO && i.number === number)!;
  issue.comments = w.gh.commentsOn(REPO, number).map((c) => ({ id: c.id, body: c.body, user: { login: c.author }, created_at: c.createdAt }));
}

/** A poll of every watch now: a change of the interval applies at once. */
async function pollNow(w: World, seconds: number): Promise<void> {
  expect((await w.a.ui('/ui/api/github-watches', { intervalSeconds: seconds }, { token: w.token })).status).toBe(200);
}

/** A job parked on its question, posted on its issue, whose watch took its first snapshot. */
async function parkedOnThread(w: World) {
  const issue = w.gh.createIssue({ repo: REPO, title: 'Paint the shed', body: 'Paint the shed.', labels: ['hopper'], assignees: ['owner'], author: 'owner' });
  w.forge.issues.push({ repo: REPO, number: issue.number, title: issue.title, body: issue.body, author: 'owner', labels: ['hopper'], assignees: ['owner'] });
  await w.a.sync();
  const job = await waitFor(() => jobOf(w.a, issue.url), { what: 'the job' });
  await w.a.waitForStatus(job.id, 'parked', 5000);
  await waitFor(async () => (await questionOf(w.a, job.id)).thread?.state === 'posted', { what: 'the question on the thread' });
  mirror(w, issue.number);
  const asked = w.gh.commentsOn(REPO, issue.number)[0]!;
  await pollNow(w, 30);
  const watch = await waitFor(async () => (await watches(w.a)).find((x) => x.pointedJob === job.id && x.snapshot?.comments.some((c) => c.id === asked.id)), { what: 'the watch saw the question' });
  return { issue, job, asked, watch };
}

describe('a reply on the issue thread, seen by the watch (issue #435 on #427)', () => {
  it('the watch sees the owner\'s reply and the job resumes with no sync of its source', { timeout: 30_000 }, async () => {
    const w = await boot();
    const { issue, job, watch } = await parkedOnThread(w);
    expect(watch).toMatchObject({ repo: REPO, pointer: { kind: 'issue', number: issue.number, url: issue.url } });

    // The watch sees the thread unchanged: a sync does not read it.
    const before = reads(w.gh);
    await w.a.sync();
    expect(reads(w.gh)).toBe(before);
    expect((await w.a.job(job.id)).status).toBe('parked');

    w.gh.addComment(REPO, issue.number, 'owner', 'Blue.', 'OWNER');
    mirror(w, issue.number);
    await pollNow(w, 31);
    await waitFor(() => w.herdr.prompts.length === 2, { what: 'the reply typed in', timeoutMs: 10_000 });
    expect(w.herdr.prompts[1]!.text).toBe('Blue.');
    expect(await questionOf(w.a, job.id)).toMatchObject({ status: 'answered', answeredBy: 'thread:owner' });
    const [seen] = changed(w.a);
    expect(seen).toMatchObject({ jobId: job.id, data: { pointedJob: job.id, changes: { comments: { added: [expect.objectContaining({ author: 'owner' })] } } } });
    await waitFor(async () => !(await watches(w.a)).some((x) => x.pointedJob === job.id), { what: 'the watch ended' });
  });

  it('a stranger\'s comment the watch saw keeps each sync reading the thread, and answers nothing', { timeout: 30_000 }, async () => {
    const w = await boot();
    const { issue, job } = await parkedOnThread(w);
    const posted = reads(w.gh);
    w.gh.addComment(REPO, issue.number, 'passer-by', 'Paint it red.', 'NONE');
    mirror(w, issue.number);
    await pollNow(w, 32);
    await waitFor(() => changed(w.a).length === 1, { what: 'the watch saw the comment' });
    await waitFor(() => reads(w.gh) > posted, { what: 'the pass read the thread' });

    const before = reads(w.gh);
    await w.a.sync();
    expect(reads(w.gh)).toBeGreaterThan(before);
    expect((await w.a.job(job.id)).status).toBe('parked');
    expect((await questionOf(w.a, job.id)).status).toBe('open');
  });
});
