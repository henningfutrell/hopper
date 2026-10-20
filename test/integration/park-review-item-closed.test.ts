// A parked proposal whose issue closes meanwhile (issue #2167), over the real daemon and the in-memory fake GitHub. Closed
// as not planned, the source's check cancels its job as for any job of a closed issue: picked up after, it is refused,
// and the proposal is cancelled but kept with every version. Closed as completed by hand, the job stays parked (it had
// started), and picked up it waits on its proposal again, as it was.
import { afterEach, describe, expect, it } from 'vitest';
import { reviewDocument, type Job, type ReviewItemView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const DOC = 'TL;DR: Leave the shed as it is.\nProblem: The shed is bare wood.\nPaths: none — no change is needed now.\nContext: the shed.';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO]);
  return a;
}

/** A started job of the github source, parked by a person on its proposal. */
function parkedOnProposal(app: TestApp, gh: FakeGitHub): { job: Job; proposalId: string } {
  const issue = gh.createIssue({ repo: REPO, body: 'Paint the shed.', labels: ['hopper', 'hopper:claimed'], assignees: ['owner'] });
  const { store } = app.user();
  return store.tx(() => {
    const created = store.jobs.create({ executor: 'scripted', payload: {} }, 50, { source: 'github', kind: 'github-account', key: issue.url, url: issue.url, repo: REPO, number: issue.number });
    const at = new Date().toISOString();
    const p = store.reviews.proposal.create({ jobId: created.id, stage: 'human', version: { number: 1, text: DOC, ...reviewDocument('proposal', DOC), recentOutput: '', at } });
    const job = store.jobs.update(created.id, { status: 'parked', startedAt: at, proposalId: p.id, resumeOn: 'local', agentSession: 's', parked: { at, from: 'waiting_answer', by: 'a person', via: 'ui', reason: 'Later.' } });
    return { job, proposalId: p.id };
  });
}

const proposals = async (app: TestApp, status: string) => (await app.api<{ items: ReviewItemView[] }>('GET', `/api/proposals?status=${status}`)).body.items;
const pickUp = (app: TestApp, token: string, id: string) => app.ui<Job>(`/ui/api/jobs/${id}/requeue`, {}, { token });

describe('a parked proposal whose issue closes', () => {
  it('closed as not planned: its job is cancelled; picked up after, it is refused, and the proposal is kept, cancelled', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const { job, proposalId } = parkedOnProposal(app, gh);
    expect((await proposals(app, 'parked')).map((p) => p.id)).toEqual([proposalId]);
    gh.closeIssue(REPO, job.source!.number!, 'owner', { at: new Date().toISOString(), reason: 'not_planned' });
    await app.sync();
    await app.waitForStatus(job.id, 'cancelled');

    const r = await pickUp(app, token, job.id);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('only a parked job');
    const kept = await waitFor(async () => (await proposals(app, 'all')).find((p) => p.id === proposalId && p.status === 'cancelled'), { what: 'the proposal cancelled' });
    expect(kept.versions).toEqual([expect.objectContaining({ number: 1, text: DOC })]);
    expect(await proposals(app, 'parked')).toEqual([]);
    expect(await proposals(app, 'open')).toEqual([]);
  });

  it('closed as completed by hand: its job stays parked; picked up, it waits on its proposal again', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    const { job, proposalId } = parkedOnProposal(app, gh);
    gh.closeIssue(REPO, job.source!.number!, 'owner', { at: new Date().toISOString() });
    await app.sync();
    expect((await app.job(job.id)).status).toBe('parked');
    expect((await pickUp(app, token, job.id)).status).toBe(200);
    expect(await app.job(job.id)).toMatchObject({ status: 'waiting_answer', proposalId });
    expect((await proposals(app, 'open')).map((p) => p.id)).toEqual([proposalId]);
  });
});
