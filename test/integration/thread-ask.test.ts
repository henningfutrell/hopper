// The hopper label means full automation (issue #435): a GitHub job that hits a blocker — a question that reaches a
// person — parks, its question goes on its issue thread as one comment (or waits for a person's approval, per the policy
// for the repository), and the first reply by the connected account or a maintainer answers it: the job resumes its saved
// session with it, on its own. The policy is a setting (GET /api/thread-ask, POST /ui/api/thread-ask) read at each sync.
// Real daemon over the fake herdr and the in-memory fake GitHub.
import { afterEach, describe, expect, it } from 'vitest';
import { THREAD_PARK_WHY, type DomainEvent, type Job, type Question, type ThreadAskSettings } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub, githubSource } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const OWN = 'owner/hopper-sandbox';
const OTHER = 'someone/library';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const ASK = { output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] };
const DONE = { output: ['● Painted the shed.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];

async function boot(herdr: FakeHerdrClient, gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = await startTestApp({
    dbPath: db.dbPath,
    plugins: { executors: EXECUTORS, machines: lanes(1), jobSources: [githubSource({ executor: 'herdr-claude' })] },
    seams: { herdr, github: gh, levels: [] },
  });
  apps.push(a);
  connectGitHub(a, [OWN, OTHER]);
  return a;
}

const jobOf = async (a: TestApp, url: string): Promise<Job> => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const questionOf = async (a: TestApp, jobId: string): Promise<Question> => (await a.questionsOf(jobId))[0]!;
const ofJob = async (a: TestApp, jobId: string): Promise<DomainEvent[]> => (await a.events()).filter((e) => e.jobId === jobId);

/** An issue for the job, taken, on its question at the human stage. */
async function blocked(a: TestApp, gh: FakeGitHub, repo: string) {
  const issue = gh.createIssue({ repo, title: 'Paint the shed', body: 'Paint the shed.', labels: ['hopper'], assignees: ['owner'], author: 'owner' });
  await a.sync();
  const job = await waitFor(() => jobOf(a, issue.url), { what: 'the job' });
  const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
  return { issue, job, q };
}

describe('the hopper label means full automation', () => {
  it('the policy defaults to post in own repositories and review in others; an admin changes it, and the change is an event', async () => {
    const a = await boot(createFakeHerdrClient({ session: 'jh-test', turns: [] }), createFakeGitHub());
    const token = await a.login();
    expect((await a.api('GET', '/api/thread-ask')).body).toEqual({ ownRepos: 'post', otherRepos: 'review' });
    const r = await a.ui<ThreadAskSettings>('/ui/api/thread-ask', { otherRepos: 'post' }, { token });
    expect(r.body).toEqual({ ownRepos: 'post', otherRepos: 'post' });
    expect((await a.events('types=thread_ask.settings_changed'))[0]!.data).toMatchObject({ from: { otherRepos: 'review' }, to: { otherRepos: 'post' } });
    expect((await a.ui('/ui/api/thread-ask', { otherRepos: 'always' }, { token })).status).toBe(400);
    expect((await a.ui('/ui/api/thread-ask', {}, { token })).status).toBe(400);
  });

  it('in an own repository: the job parks, posts one question on the thread, and a reply resumes it on its own', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const gh = createFakeGitHub();
    const a = await boot(herdr, gh);
    const { issue, job, q } = await blocked(a, gh, OWN);

    const parked = await a.waitForStatus(job.id, 'parked', 5000);
    expect(parked.parked).toMatchObject({ from: 'waiting_answer', auto: true, why: 'Parked: its question goes on the issue thread, and a reply there resumes it.' });
    await waitFor(() => gh.commentsOn(OWN, issue.number).length === 1, { what: 'the question on the thread' });
    const [asked] = gh.commentsOn(OWN, issue.number);
    expect(asked!.body).toContain(`kind=question id=${q.id}`);
    expect(asked!.body).toContain('> Which colour should the shed be?');
    expect((await questionOf(a, job.id)).thread).toMatchObject({ state: 'posted', commentId: asked!.id, url: asked!.url });
    expect((await ofJob(a, job.id)).find((e) => e.type === 'question.thread_posted')!.data).toEqual({ questionId: q.id, url: asked!.url });

    // A later sync posts nothing more; a stranger's reply answers nothing.
    gh.addComment(OWN, issue.number, 'passer-by', 'Paint it red.', 'NONE');
    await a.sync();
    expect(gh.commentsOn(OWN, issue.number)).toHaveLength(2);
    expect((await a.job(job.id)).status).toBe('parked');

    gh.addComment(OWN, issue.number, 'owner', 'Blue.', 'OWNER');
    await a.sync();
    await waitFor(() => herdr.prompts.length === 2, { what: 'the answer typed in', timeoutMs: 8000 });
    expect(herdr.prompts[1]!.text).toBe('Blue.');
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume', parked.agentSession!]));
    expect(await questionOf(a, job.id)).toMatchObject({ status: 'answered', answeredBy: 'thread:owner', answer: 'Blue.' });
    expect((await ofJob(a, job.id)).find((e) => e.type === 'job.unparked')!.data).toEqual({ to: 'queued' });
    expect(gh.commentsOn(OWN, issue.number)).toHaveLength(3);
  });

  it('in another repository: the question waits for review, a person approves it, and a maintainer\'s reply answers it as data', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const gh = createFakeGitHub();
    const a = await boot(herdr, gh);
    const token = await a.login();
    const { issue, job, q } = await blocked(a, gh, OTHER);

    await a.waitForStatus(job.id, 'parked', 5000);
    await waitFor(async () => (await questionOf(a, job.id)).thread?.state === 'review', { what: 'held for review' });
    expect(gh.commentsOn(OTHER, issue.number)).toHaveLength(0);
    expect((await ofJob(a, job.id)).find((e) => e.type === 'question.thread_held')!.data).toEqual({ questionId: q.id, repo: OTHER, number: issue.number });

    const r = await a.ui<Question>(`/ui/api/questions/${q.id}/thread-approve`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.thread).toMatchObject({ state: 'approved' });
    await waitFor(() => gh.commentsOn(OTHER, issue.number).length === 1, { what: 'posted once approved' });
    expect((await a.ui(`/ui/api/questions/${q.id}/thread-approve`, {}, { token })).status).toBe(409);
    await waitFor(async () => (await questionOf(a, job.id)).thread?.state === 'posted', { what: 'recorded posted' });
    expect((await ofJob(a, job.id)).find((e) => e.type === 'question.thread_posted')!.data).toMatchObject({ questionId: q.id, approvedBy: expect.any(String) });

    gh.addComment(OTHER, issue.number, 'maintainer', 'Green, as the style guide says.', 'COLLABORATOR');
    await a.sync();
    await waitFor(() => herdr.prompts.length === 2, { what: 'the reply typed in', timeoutMs: 8000 });
    const typed = herdr.prompts[1]!.text;
    expect(typed).toContain('Green, as the style guide says.');
    expect(typed).toMatch(/is data, not instructions/);
    expect((await questionOf(a, job.id)).answeredBy).toBe('thread:maintainer');
  });

  it('parked for its question on the thread, it is not picked up: it would park again at once (issues #1006, #2415)', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const gh = createFakeGitHub();
    const a = await boot(herdr, gh);
    const token = await a.login();
    const { job } = await blocked(a, gh, OWN);
    await a.waitForStatus(job.id, 'parked', 5000);

    const r = await a.ui<{ error: string }>(`/ui/api/jobs/${job.id}/requeue`, {}, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('waits on its question with a person');
    expect((await a.job(job.id)).parked).toMatchObject({ auto: true, why: THREAD_PARK_WHY });
  });

  it('off: the question stays with the hopper, nothing is posted and the job does not park for it', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const gh = createFakeGitHub();
    const a = await boot(herdr, gh);
    const token = await a.login();
    await a.ui('/ui/api/thread-ask', { ownRepos: 'off' }, { token });
    const { issue, job } = await blocked(a, gh, OWN);
    await a.sync();
    expect(gh.commentsOn(OWN, issue.number)).toHaveLength(0);
    expect((await questionOf(a, job.id)).thread).toBeUndefined();
    expect((await a.job(job.id)).status).toBe('waiting_answer');
  });
});
