// A GitLab source (issue #1448, design.md "A GitLab source", "Jobs through GitLab"), through the real daemon, store and HTTP
// edge, with Access (the in-memory OpenFGA); GitLab is a fake on loopback (test/support/fake-gitlab.ts).
//
// Feature: a GitLab source
//   Scenario: a user connects GitLab with a personal access token and picks projects; the hopper adds the GitLab source, and
//     Intake lists the labelled open issues of the picked projects; the account's own issue becomes a job, of the GitLab
//     source, and its issue is labelled claimed at GitLab; another person's issue says why it is not taken
//   Scenario: the token is never answered; no account to pick for is not found; removing the account removes its source
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceStatus } from '../../src/domain/types.ts';
import type { GitLabAccountStatus } from '../../src/domain/gitlab-account.ts';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { REQUEST_REASON } from '../../src/sources/github/origin.ts';
import { createFakeGitLab } from '../support/fake-gitlab.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const gitlab = await createFakeGitLab({
    issues: [
      { project: 'ada/tools', iid: 1, title: 'Fix the parser', description: 'It drops the last line.', author: 'ada', assignees: ['ada'], labels: ['hopper'] },
      { project: 'ada/tools', iid: 2, title: 'From bob', description: 'Do this.', author: 'bob', assignees: ['ada'], labels: ['hopper'], labelledBy: 'ada', assignedBy: 'ada' },
      { project: 'acme/api', iid: 5, title: 'Not picked', author: 'ada', assignees: ['ada'], labels: ['hopper'] },
    ],
  });
  cleanups.push(() => gitlab.close());
  gitlab.tokens.set('glpat-ada', { id: 7, username: 'ada', email: 'ada@example.com', projects: ['ada/tools', 'acme/api'] });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({ dbPath: db.dbPath });
  apps.push(app);
  return { app, gitlab };
}

const post = (app: TestApp, token: string, body: Record<string, unknown>) => app.ui<{ account: GitLabAccountStatus; error?: string }>('/ui/api/gitlab-account', body, { token });
const sources = async (app: TestApp) => (await app.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources;
const gitlabSource = async (app: TestApp) => (await sources(app)).find((s) => s.kind === 'gitlab-account');

describe('a GitLab source', () => {
  it('takes the account\'s own issue as a job, labels it claimed at GitLab, and offers another person\'s as a request card a person approves', async () => {
    const { app, gitlab } = await setup();
    const token = await app.login();
    expect(await gitlabSource(app)).toBeUndefined();
    const connected = await post(app, token, { action: 'connect', token: 'glpat-ada', baseUrl: gitlab.url });
    expect(connected.body.account).toMatchObject({ state: 'connected', account: 'ada', reached: ['ada/tools', 'acme/api'], projects: [] });
    const paused = await waitFor(async () => { const s = await gitlabSource(app); return typeof s?.detail.paused === 'string' ? s : undefined; }, { what: 'the GitLab source' });
    expect(paused.detail.paused).toContain('no GitLab project is picked');

    expect((await post(app, token, { action: 'choose', projects: ['ada/tools'] })).body.account).toMatchObject({ projects: ['ada/tools'] });
    const key = `${gitlab.url}/ada/tools/-/issues/1`;
    const job = await waitFor(async () => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.find((j) => j.source?.key === key), { what: 'the GitLab issue\'s job' });
    expect(job.source).toMatchObject({ kind: 'gitlab-account', repo: 'ada/tools', number: 1, url: key, origin: 'trusted' });
    // Its origin acts (issue #655 part 14): who wrote it, each a trusted actor.
    expect(job.source!.originActs).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'author', login: 'ada', trusted: true })]));
    expect(job.source!.originActs!.every((x) => x.trusted)).toBe(true);
    expect(job.spec.payload.prompt).toContain(`git push to ${gitlab.url} go through the hopper`);
    // The job can fail before a poll sees the claim on the issue, so wait for the claim's request, not the label.
    await waitFor(() => gitlab.requests.some((r) => r.method === 'PUT' && JSON.stringify(r.body) === JSON.stringify({ add_labels: 'hopper:claimed' })) || undefined, { what: 'the claimed label at GitLab' });
    const listed = await waitFor(async () => { const i = (await gitlabSource(app))?.detail.intake as IntakeOutcome[] | undefined; return i?.length === 2 ? i : undefined; }, { what: 'Intake to list the GitLab issues' });
    expect(listed.find((x) => x.key === key)).toMatchObject({ jobId: job.id });
    expect(listed.find((x) => x.title === 'From bob')).toMatchObject({ reason: REQUEST_REASON, group: 'request', action: 'approve', request: { why: ['bob wrote it, and is not a trusted actor'] } });
    expect(gitlab.requests.every((r) => r.token === 'glpat-ada')).toBe(true);
    expect(gitlab.requests.some((r) => r.path.includes('acme%2Fapi/issues'))).toBe(false);
    // The test daemon has no herdr-claude executor, so the job fails at once: its end label replaces the claim.
    await waitFor(async () => ((await app.api<Job>('GET', `/api/jobs/${job.id}`)).body.status === 'failed') || undefined, { what: 'the job to end' });
    await waitFor(() => gitlab.issues.find((i) => i.iid === 1)!.labels.includes('hopper:failed') || undefined, { what: 'the end label at GitLab' });
    expect(gitlab.requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body])).toEqual([
      ['/api/v4/projects/ada%2Ftools/issues/1', { add_labels: 'hopper:claimed' }],
      // Outbox rows (issue #1892 part 17): the claim comes off, then the end label goes on.
      ['/api/v4/projects/ada%2Ftools/issues/1', { remove_labels: 'hopper:claimed' }],
      ['/api/v4/projects/ada%2Ftools/issues/1', { add_labels: 'hopper:failed' }],
    ]);
    expect(gitlab.issues.find((i) => i.iid === 1)!.labels).toEqual(['hopper', 'hopper:failed']);

    // A person approves bob's request card (issue #1642): the next sync takes its text as a job of origin approved.
    const card = listed.find((x) => x.title === 'From bob')!;
    const approved = await app.ui<{ done: string[] }>('/ui/api/sources/gitlab-account/intake', { kind: 'approve', keys: [card.key], hash: card.request!.hash }, { token });
    expect(approved.body.done).toEqual([card.key]);
    await app.sync();
    const bobs = await waitFor(async () => (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs.find((j) => j.source?.key === card.key), { what: 'the approved card\'s job' });
    expect(bobs.source).toMatchObject({ kind: 'gitlab-account', number: 2, origin: 'approved' });
    expect(bobs.source!.originActs).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'author', login: 'bob', trusted: false })]));
    expect(bobs.spec.payload.prompt).toContain('Do this.');
  });

  it('never answers the token, finds no account to pick for, and removes the source with the account', async () => {
    const { app, gitlab } = await setup();
    const token = await app.login();
    expect((await post(app, token, { action: 'choose', projects: ['ada/tools'] })).status).toBe(404);
    expect((await post(app, token, { action: 'connect', token: 'glpat-nobody', baseUrl: gitlab.url })).body.account).toMatchObject({ state: 'failed' });
    await post(app, token, { action: 'connect', token: 'glpat-ada', baseUrl: gitlab.url });
    const read = await app.api<{ account: GitLabAccountStatus }>('GET', '/api/gitlab-account');
    expect(read.body.account).toMatchObject({ state: 'connected', account: 'ada' });
    expect(JSON.stringify(read.body)).not.toContain('glpat');
    await waitFor(async () => (await gitlabSource(app)) !== undefined, { what: 'the GitLab source' });
    expect((await post(app, token, { action: 'disconnect' })).body.account).toEqual({ state: 'not-connected' });
    await waitFor(async () => (await gitlabSource(app)) === undefined, { what: 'the GitLab source to go' });
  });
});
