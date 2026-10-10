// Item snapshots end to end (issue #662): a job's item text is recorded at intake, and no later job of the item runs
// text that differs from it unless the owner accepted it — Run again, a failure's retry, a rediscovered item, a job edited
// while it waits. Real daemon, in-memory fake GitHub at the GitHubApi seam, OpenFGA's double at its seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { TEXT_CHANGED } from '../../src/decider/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { connectGitHub } from '../support/github-account.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';

const REPO = 'owner/hopper-sandbox';
const ORIGINAL = '{"op":"fail","message":"original text ran"}';
const EDITED = '{"op":"fail","message":"edited text ran"}';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub, o: { openFga?: boolean } = {}) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh, ...(o.openFga ? { authorizationServer: createFakeAuthorizationServer() } : {}) }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

/** An issue whose first job ran and failed with the original text, reported to GitHub. */
async function failedOnce(gh: FakeGitHub, a: TestApp) {
  const issue = gh.createIssue({ repo: REPO, title: 'Do the thing', body: ORIGINAL, labels: ['hopper'] });
  const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
  await a.sync();
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
  const [first] = await jobsFor();
  expect(first!.error).toBe('original text ran');
  return { issue, first: first!, jobsFor };
}

const job = async (a: TestApp, id: string) => (await a.api<Job>('GET', `/api/jobs/${id}`)).body;

describe('Item snapshots (issue #662)', () => {
  it('the first job records its item\'s text and hash; Run again with no edit runs at once with the snapshot', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, first } = await failedOnce(gh, a);
    const recorded = await a.events('types=item.snapshot_recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ jobId: first.id, data: { key: issue.url, reason: 'intake', hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });

    const r = await a.ui<Job>(`/ui/api/jobs/${first.id}/rerun`, {}, { token });
    expect(r.status).toBe(200);
    expect(r.body.textChange).toBeUndefined();
    const second = await a.waitForStatus(r.body.id, 'failed');
    expect(second.error).toBe('original text ran');
    expect(await a.events('types=item.changed_since_snapshot')).toEqual([]);
    // One snapshot per item: a rerun records none.
    expect(await a.events('types=item.snapshot_recorded')).toHaveLength(1);
  });

  it('an issue edited after a failed run: Run again holds the new job with the change shown, never runs the edited text; Rerun the original runs the snapshot', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, first } = await failedOnce(gh, a);
    gh.editIssue(REPO, issue.number, { title: 'Do another thing', body: EDITED }, 'someone-else');
    gh.addComment(REPO, issue.number, 'owner', 'Also do this.');

    const r = await a.ui<Job>(`/ui/api/jobs/${first.id}/rerun`, {}, { token });
    expect(r.status).toBe(200);
    const held = await waitFor(async () => { const j = await job(a, r.body.id); return j.holdReason === TEXT_CHANGED ? j : undefined; }, { what: 'held for the change' });
    expect(held.status).toBe('held');
    // The job holds the original text; the card shows both and who edited it.
    expect(held.spec.payload.body).toBe(ORIGINAL);
    expect(held.spec.goal).toBe('Do the thing');
    expect(held.textChange).toMatchObject({
      from: { title: 'Do the thing', body: ORIGINAL, comments: [] },
      to: { title: 'Do another thing', body: EDITED, comments: [{ author: 'owner', body: 'Also do this.' }] },
      edits: expect.arrayContaining([{ what: 'body', editor: 'someone-else', at: expect.any(String) }, { what: 'title', editor: 'someone-else', at: expect.any(String) }]),
    });
    const [changed] = await a.events('types=item.changed_since_snapshot');
    expect(changed).toMatchObject({ jobId: r.body.id, data: { key: issue.url, editors: ['someone-else'], newComments: 1 } });
    expect(JSON.stringify(changed!.data)).not.toContain('edited text ran');
    // A sync while it is held changes nothing: the same text is already held.
    await a.sync();
    expect(await a.events('types=item.changed_since_snapshot')).toHaveLength(1);

    const kept = await a.ui<Job>(`/ui/api/jobs/${r.body.id}/keep-original`, {}, { token });
    expect(kept.status).toBe(200);
    expect(kept.body.textChange).toBeUndefined();
    const ran = await a.waitForStatus(r.body.id, 'failed');
    expect(ran.error).toBe('original text ran');
    expect((await a.events('types=item.original_kept')).map((e) => e.jobId)).toEqual([r.body.id]);
  });

  it('Accept the new text, as the owner Access allows: a new snapshot is recorded and the job runs the new text', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh, { openFga: true });
    const token = await a.login();
    const { issue, first } = await failedOnce(gh, a);
    gh.editIssue(REPO, issue.number, { body: EDITED }, 'owner');
    const r = await a.ui<Job>(`/ui/api/jobs/${first.id}/rerun`, {}, { token });
    await waitFor(async () => (await job(a, r.body.id)).textChange, { what: 'held for the change' });

    const accepted = await a.ui<Job>(`/ui/api/jobs/${r.body.id}/accept-new-text`, {}, { token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.textChange).toBeUndefined();
    expect(accepted.body.spec.payload.body).toBe(EDITED);
    const ran = await a.waitForStatus(r.body.id, 'failed');
    expect(ran.error).toBe('edited text ran');
    const [acceptance] = await a.events('types=item.new_text_accepted');
    expect(acceptance).toMatchObject({ jobId: r.body.id, data: { key: issue.url, editors: ['owner'], via: 'ui' } });
    const snapshots = await a.events('types=item.snapshot_recorded');
    expect(snapshots.map((e: DomainEvent) => e.data.reason)).toEqual(['intake', 'accepted']);
    expect(snapshots[1]!.data.hash).toBe(acceptance!.data.toHash);

    // The accepted text is the snapshot now: Run again runs it at once.
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed again' });
    await a.sync();
    const again = await a.ui<Job>(`/ui/api/jobs/${r.body.id}/rerun`, {}, { token });
    expect(again.status).toBe(200);
    expect(again.body.textChange).toBeUndefined();
    expect(again.body.spec.payload.body).toBe(EDITED);
  });

  it('without owner rights through Access — no OpenFGA to ask — the new text cannot be accepted, from the UI or the CLI\'s route', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const { issue, first } = await failedOnce(gh, a);
    gh.editIssue(REPO, issue.number, { body: EDITED }, 'someone-else');
    const r = await a.ui<Job>(`/ui/api/jobs/${first.id}/rerun`, {}, { token });
    await waitFor(async () => (await job(a, r.body.id)).textChange, { what: 'held for the change' });

    const refused = await a.ui<{ error: string }>(`/ui/api/jobs/${r.body.id}/accept-new-text`, {}, { token });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/OpenFGA is not set up/);
    const still = await job(a, r.body.id);
    expect(still.textChange).toBeDefined();
    expect(still.spec.payload.body).toBe(ORIGINAL);
    expect(await a.events('types=item.new_text_accepted')).toEqual([]);
  });

  it('a queued job whose issue is edited is held before it starts, its text kept', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    expect((await a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(200);
    const issue = gh.createIssue({ repo: REPO, title: 'Do the thing', body: ORIGINAL, labels: ['hopper'] });
    await a.sync();
    const [queued] = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    expect(queued!.accepted).toBe(false);

    gh.editIssue(REPO, issue.number, { body: EDITED }, 'someone-else');
    await a.sync();
    const held = await job(a, queued!.id);
    expect(held.textChange).toMatchObject({ from: { body: ORIGINAL }, to: { body: EDITED }, edits: [{ what: 'body', editor: 'someone-else' }] });
    expect(held.spec.payload.body).toBe(ORIGINAL);
    // Accepted through the queue gate, it is still held: no acceptance starts a job whose text changed.
    expect((await a.ui('/ui/api/queue/order', { jobIds: [queued!.id] }, { token })).status).toBe(200);
    await waitFor(async () => (await job(a, queued!.id)).holdReason === TEXT_CHANGED, { what: 'held for the change after acceptance' });

    // Rerun the original: it runs the snapshot's text, and a later sync of the same edit does not hold it again.
    expect((await a.ui(`/ui/api/jobs/${queued!.id}/keep-original`, {}, { token })).status).toBe(200);
    const ran = await a.waitForStatus(queued!.id, 'failed');
    expect(ran.error).toBe('original text ran');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
  });

  it('an item offered again by hand — its end label removed — after an edit: the new job holds, the snapshot\'s text kept', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await a.login();
    const { issue, first, jobsFor } = await failedOnce(gh, a);
    gh.editIssue(REPO, issue.number, { body: EDITED }, 'someone-else');
    gh.removeLabel(REPO, issue.number, 'hopper:failed');
    await a.sync();
    const next = await waitFor(async () => (await jobsFor()).find((j) => j.id !== first.id), { what: 'the new job' });
    expect(next.textChange).toMatchObject({ to: { body: EDITED } });
    expect(next.spec.payload.body).toBe(ORIGINAL);
  });

  it('the assessor\'s rerun of a transient failure runs the snapshot: the issue edited meanwhile holds the new job', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    expect((await a.ui('/ui/api/failures/settings', { maxAttempts: 2, backoffSec: 1, backoffFactor: 1 }, { token })).status).toBe(200);
    const issue = gh.createIssue({ repo: REPO, title: 'Do the thing', body: '{"op":"fail","message":"read ECONNRESET"}', labels: ['hopper'] });
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    gh.editIssue(REPO, issue.number, { body: EDITED }, 'someone-else');

    const rerun = await waitFor(async () => (await a.events('types=job.rerun')).find((e) => e.data.by === 'assessor'), { timeoutMs: 10_000, what: 'the assessor\'s rerun' });
    const next = await waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.rerunOf === rerun.jobId), { what: 'the new job' });
    const held = await waitFor(async () => { const j = await job(a, next.id); return j.holdReason === TEXT_CHANGED ? j : undefined; }, { what: 'held for the change' });
    expect(held.spec.payload.body).toBe('{"op":"fail","message":"read ECONNRESET"}');
    expect(held.textChange).toMatchObject({ to: { body: EDITED }, edits: [{ what: 'body', editor: 'someone-else' }] });
  });
});
