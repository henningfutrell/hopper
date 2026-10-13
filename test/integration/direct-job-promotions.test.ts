// Issue #946: Promote to GitHub. A direct job's outputs stay private in the hopper; when it finished, a person may promote
// it: a preview first, which they edit and confirm, then an issue — or a comment on one they pick — on a repository they
// choose, posted with their own GitHub connection, never the job's. The daemon, store and HTTP edge are real; GitHub is a
// fake on loopback (test/support/fake-forges.ts).
//
// Feature: Promote to GitHub
//   Scenario: a finished direct job with an artifact is offered, previewed and promoted as an issue
//     Given a finished direct job whose brief names an email address, and an artifact of its job
//     When the person asks for a preview on a public repository
//     Then the brief is cleaned, the hopper's own labels are left out, and the repository reads as public
//     And a promotion to a public repository is refused until the person confirms it
//     When the person confirms it
//     Then an issue is filed with the person's own token, with the routing labels, the results, the artifact as a link
//     And direct_job.promoted is in the log, and the direct job links the issue
//   Scenario: promoting twice updates the issue; an artifact changed after it is stale
//   Scenario: a secret is never posted; personal data only on a private repository, when the person allows it
//   Scenario: a comment on an issue the person picks; a revoke leaves GitHub as it is
//   Scenario: no promotion of a job not ended, or with no GitHub connection
//   Scenario: promote when done, asked at submit
//   Scenario: a small text artifact is committed to the promotion's branch, so it opens on GitHub with no hopper sign-in
//   Scenario: a binary artifact is not committed; nor is one with personal data, on a public repository
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'octo-org/hello';
const PRIVATE_REPO = 'octo-org/ops';
const PUBLIC_URL = 'https://hopper.example.com';

async function start(o: { connected?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'promoter');
  github.privateRepos = [PRIVATE_REPO];
  github.issues.push({ repo: PRIVATE_REPO, number: 4, title: 'Sign-in lockouts', body: '', author: 'someone', labels: [] });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test', HOPPER_PUBLIC_URL: PUBLIC_URL },
  });
  apps.push(app);
  if (o.connected !== false) connectGitHub(app, [REPO], { login: 'promoter' });
  return { app, github, token: await app.login() };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const readBack = (a: TestApp, id: string, ok: (d: DirectJobView) => boolean) => waitFor(async () => {
  const d = (await a.api<DirectJobView>('GET', `/api/direct-jobs/${id}`)).body;
  return ok(d) ? d : undefined;
}, { what: `direct job ${id}` });

/** A direct job that finished, and an artifact its job made. */
async function finished(app: TestApp, token: string, more: Record<string, unknown> = {}) {
  const op = more.op ?? { op: 'echo', message: 'Two failed sign-ins, then a lockout.' };
  const r = await app.ui<{ directJob: DirectJobView; job: { id: string } }>('/ui/api/direct-jobs', {
    title: 'Why was a sign-in locked?', brief: `${JSON.stringify(op)}\nThe user ada@example.com is locked out. Find out why.`,
    labels: ['sme:identity', 'hopper:high'], authorizations: ['keycloak:read'], executor: 'scripted', repo: REPO, ...more, op: undefined,
  }, { token });
  expect(r.status).toBe(200);
  const { directJob, job } = r.body;
  if ((op as { op: string }).op === 'echo') await app.waitForStatus(job.id, 'finished');
  const rt = app.user(ADMIN_ID);
  const put = rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'timeline.svg', title: 'Lockout timeline', summary: 'When each sign-in failed', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
  if ('no' in put) throw new Error(put.no);
  return { directJob, job, artifact: put };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any };
const preview = (app: TestApp, token: string, id: string, body: Record<string, unknown>): Promise<Answer> => app.ui(`/ui/api/direct-jobs/${id}/promotion/preview`, body, { token });
const promote = (app: TestApp, token: string, id: string, body: Record<string, unknown>): Promise<Answer> => app.ui(`/ui/api/direct-jobs/${id}/promotion`, body, { token });

describe('Promote to GitHub (issue #946)', () => {
  it('offers a finished direct job, previews it cleaned, and promotes it as an issue with the person\'s own token', async () => {
    const { app, github, token } = await start();
    const { directJob, artifact } = await finished(app, token);
    const offered = await readBack(app, directJob.id, (d) => d.artifacts.length > 0);
    expect(offered.offer).toBe('suggested');
    expect(offered.artifacts[0]).toMatchObject({ id: artifact.id, title: 'Lockout timeline', revision: 1 });

    const p = await preview(app, token, directJob.id, {});
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ repo: REPO, visibility: 'public', target: { kind: 'issue' }, title: 'Why was a sign-in locked?', labels: ['sme:identity'] });
    expect(p.body.body).toContain('Find out why.');
    expect(p.body.body).toContain('Two failed sign-ins, then a lockout.');
    expect(p.body.body).not.toContain('ada@example.com');
    expect(p.body.artifacts.map((a: { id: string }) => a.id)).toEqual([artifact.id]);
    expect(p.body.notes.join(' ')).toMatch(/does not unpublish/);
    expect(github.issues.filter((i) => i.repo === REPO)).toEqual([]);

    const draft = { repo: REPO, target: { kind: 'issue' }, title: p.body.title, body: p.body.body, labels: p.body.labels, artifacts: [artifact.id] };
    const unconfirmed = await promote(app, token, directJob.id, draft);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error).toMatch(/public/);

    const done = await promote(app, token, directJob.id, { ...draft, confirmPublic: true });
    expect(done.status).toBe(200);
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: 'Why was a sign-in locked?', author: 'promoter', labels: ['sme:identity'], assignees: [] });
    expect(issue.body).toContain(`[Lockout timeline](${PUBLIC_URL}/#artifacts/${artifact.id})`);
    expect(issue.body).toContain(`${PUBLIC_URL}/#direct-jobs/${directJob.id}`);
    expect(issue.body).toContain('Promoted by promoter.');
    const create = github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${REPO}/issues`))!;
    expect(create.auth).toContain('test-account-token');
    expect(done.body).toMatchObject({ repo: REPO, kind: 'issue', number: issue.number, url: `${github.url}/${REPO}/issues/${issue.number}` });

    const [event] = eventsOf(app, 'direct_job.promoted');
    expect(event?.data).toEqual({ id: directJob.id, repo: REPO, kind: 'issue', number: issue.number, url: done.body.url, by: expect.any(String), artifacts: 1, update: false });
    expect(JSON.stringify(event?.data)).not.toContain('sign-in locked');
    const after = (await app.api<DirectJobView>('GET', `/api/direct-jobs/${directJob.id}`)).body;
    expect(after.promotion).toMatchObject({ url: done.body.url, stale: [] });
    expect(after.offer).toBeUndefined();
  });

  it('updates the same issue when promoted twice; an artifact changed after is stale', async () => {
    const { app, github, token } = await start();
    const { directJob, job, artifact } = await finished(app, token);
    const draft = { repo: REPO, target: { kind: 'issue' }, title: 'Lockouts', body: 'First take.', labels: [], artifacts: [artifact.id], confirmPublic: true };
    const first = await promote(app, token, directJob.id, draft);
    expect(first.status).toBe(200);
    const rt = app.user(ADMIN_ID);
    rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'timeline.svg', title: 'Lockout timeline', to: artifact.id, content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>') });
    expect((await app.api<DirectJobView>('GET', `/api/direct-jobs/${directJob.id}`)).body.promotion!.stale).toEqual([artifact.id]);

    const again = await preview(app, token, directJob.id, {});
    expect(again.body.update).toMatchObject({ kind: 'issue', number: first.body.number });
    const second = await promote(app, token, directJob.id, { ...draft, body: 'Second take.' });
    expect(second.status).toBe(200);
    expect(second.body.number).toBe(first.body.number);
    const issues = github.issues.filter((i) => i.repo === REPO);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain('Second take.');
    expect(issues[0]!.body).toContain('(revision 2)');
    expect((await app.api<DirectJobView>('GET', `/api/direct-jobs/${directJob.id}`)).body.promotion!.stale).toEqual([]);
    expect(eventsOf(app, 'direct_job.promoted').map((e) => e.data.update)).toEqual([true, false]);
    expect((await promote(app, token, directJob.id, { ...draft, repo: PRIVATE_REPO })).status).toBe(409);
  });

  it('never posts a secret; posts personal data only on a private repository, when the person allows it', async () => {
    const { app, github, token } = await start();
    const { directJob } = await finished(app, token);
    const base = { repo: PRIVATE_REPO, target: { kind: 'issue' }, title: 'Lockouts', labels: [], artifacts: [] };
    const secret = await promote(app, token, directJob.id, { ...base, body: `use ghp_${'a1B2'.repeat(9)}`, allowPersonalData: true });
    expect(secret.status).toBe(422);
    expect(secret.body.error).toMatch(/secret/);
    const personal = await promote(app, token, directJob.id, { ...base, body: 'ask ada@example.com' });
    expect(personal.status).toBe(422);
    expect(personal.body.error).toMatch(/personal data/);
    expect(github.issues.filter((i) => i.repo === PRIVATE_REPO)).toHaveLength(1);

    const allowed = await promote(app, token, directJob.id, { ...base, body: 'ask ada@example.com', allowPersonalData: true });
    expect(allowed.status).toBe(200);
    expect(github.issues.find((i) => i.repo === PRIVATE_REPO && i.number === allowed.body.number)!.body).toContain('ada@example.com');
  });

  it('comments on an issue the person picks; a revoke leaves GitHub as it is', async () => {
    const { app, github, token } = await start();
    const { directJob } = await finished(app, token);
    const p = await preview(app, token, directJob.id, { repo: PRIVATE_REPO, target: { kind: 'comment', number: 4 } });
    expect(p.body).toMatchObject({ repo: PRIVATE_REPO, visibility: 'private', target: { kind: 'comment', number: 4 } });
    const done = await promote(app, token, directJob.id, { repo: PRIVATE_REPO, target: { kind: 'comment', number: 4 }, title: p.body.title, body: 'What we found.', labels: [], artifacts: [] });
    expect(done.status).toBe(200);
    const comments = github.issues.find((i) => i.repo === PRIVATE_REPO && i.number === 4)!.comments!;
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!.body)).toContain('What we found.');
    expect(done.body).toMatchObject({ kind: 'comment', number: 4, url: comments[0]!.html_url });
    expect((await promote(app, token, directJob.id, { repo: PRIVATE_REPO, target: { kind: 'comment', number: 99 }, title: 't', body: 'b', labels: [], artifacts: [] })).status).toBe(409);

    const revoked = await app.ui<{ revoked: boolean; note: string }>(`/ui/api/direct-jobs/${directJob.id}/promotion/revoke`, {}, { token });
    expect(revoked.status).toBe(200);
    expect(revoked.body.note).toMatch(/GitHub keeps/);
    expect(github.issues.find((i) => i.number === 4 && i.repo === PRIVATE_REPO)!.comments).toHaveLength(1);
    expect((await app.api<DirectJobView>('GET', `/api/direct-jobs/${directJob.id}`)).body.promotion).toBeUndefined();
    expect(eventsOf(app, 'direct_job.promotion_revoked')).toHaveLength(1);
    expect((await app.ui(`/ui/api/direct-jobs/${directJob.id}/promotion/revoke`, {}, { token })).status).toBe(404);
  });

  it('promotes no job that has not ended, and none without the person\'s GitHub connection', async () => {
    const { app, token } = await start({ connected: false });
    const { directJob } = await finished(app, token);
    const r = await preview(app, token, directJob.id, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/GitHub is not connected/);
    const held = await finished(app, token, { op: { op: 'sleep', ms: 60_000 } });
    expect((await preview(app, token, held.directJob.id, {})).body.error).toMatch(/not ended/);
    expect((await preview(app, token, 'no-such-id', {})).status).toBe(404);
  });

  it('asks for a promotion when done, when the submitter opted in', async () => {
    const { app, token } = await start();
    const { directJob } = await finished(app, token, { promoteWhenDone: true });
    expect(directJob.promoteWhenDone).toBe(true);
    expect((await readBack(app, directJob.id, (d) => d.job?.status === 'finished')).offer).toBe('asked');
  });

  it('commits a small text artifact to the promotion\'s own branch, and links it there; promoted again, the file is updated', async () => {
    const { app, github, token } = await start();
    const { directJob, job, artifact } = await finished(app, token);
    const branch = `hopper-promotion/${directJob.id}`;
    const path = `hopper-promotions/${directJob.id}/${artifact.id}-timeline.svg`;
    const p = await preview(app, token, directJob.id, { repo: PRIVATE_REPO });
    expect(p.body.artifacts[0].commit).toEqual({ branch, path });
    expect(p.body.notes.join(' ')).toMatch(/committed/);

    const draft = { repo: PRIVATE_REPO, target: { kind: 'issue' }, title: 'Lockouts', body: 'What we found.', labels: [], artifacts: [artifact.id], commit: [artifact.id] };
    const done = await promote(app, token, directJob.id, draft);
    expect(done.status).toBe(200);
    expect(github.branches![`${PRIVATE_REPO}@${branch}`]).toBe('f'.repeat(40));
    const file = github.files![`${PRIVATE_REPO}@${branch}:${path}`]!;
    expect(file.content).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(file.message).toBe('Promote timeline.svg, revision 1, from the hopper');
    const put = github.requests.find((q) => q.method === 'PUT')!;
    expect(put.auth).toContain('test-account-token');
    const blob = `${github.url}/${PRIVATE_REPO}/blob/${branch}/${path}`;
    const issue = github.issues.find((i) => i.repo === PRIVATE_REPO && i.number === done.body.number)!;
    expect(issue.body).toContain(`[Lockout timeline](${blob})`);
    expect(issue.body).toContain(`committed to branch \`${branch}\``);
    expect(done.body.artifacts[0]).toEqual({ id: artifact.id, title: 'Lockout timeline', revision: 1, committed: { branch, path, url: blob } });

    const rt = app.user(ADMIN_ID);
    rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'timeline.svg', title: 'Lockout timeline', to: artifact.id, content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>') });
    const again = await promote(app, token, directJob.id, draft);
    expect(again.status).toBe(200);
    expect(github.files![`${PRIVATE_REPO}@${branch}:${path}`]!.content).toContain('<g/>');
    expect(github.issues.filter((i) => i.repo === PRIVATE_REPO)).toHaveLength(2);
    expect(github.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/git/refs'))).toHaveLength(1);
  });

  it('commits no binary artifact, none not linked, and none with personal data on a public repository', async () => {
    const { app, github, token } = await start();
    const { directJob, job, artifact } = await finished(app, token);
    const rt = app.user(ADMIN_ID);
    const png = rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'chart.png', title: 'A chart', summary: 'A chart', separate: true, content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    if ('no' in png) throw new Error(png.no);
    const mail = rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'who.md', title: 'Who', summary: 'Who asked', separate: true, content: Buffer.from('Asked by ada@example.com') });
    if ('no' in mail) throw new Error(mail.no);
    const p = await preview(app, token, directJob.id, {});
    expect(p.body.artifacts.find((a: { id: string }) => a.id === png.id).commit.no).toMatch(/text/);

    const base = { repo: REPO, target: { kind: 'issue' }, title: 'Lockouts', body: 'What we found.', labels: [], confirmPublic: true };
    const binary = await promote(app, token, directJob.id, { ...base, artifacts: [png.id], commit: [png.id] });
    expect(binary.status).toBe(400);
    expect(binary.body.error).toMatch(/text/);
    const unlinked = await promote(app, token, directJob.id, { ...base, artifacts: [], commit: [artifact.id] });
    expect(unlinked.status).toBe(400);
    const personal = await promote(app, token, directJob.id, { ...base, artifacts: [mail.id], commit: [mail.id] });
    expect(personal.status).toBe(422);
    expect(personal.body.error).toMatch(/who\.md.*personal data/);
    const key = rt.artifacts.put(rt.store.jobs.get(job.id)!, { name: 'keys.txt', title: 'Keys', summary: 'Keys', separate: true, content: Buffer.from(`AKIA${'A'.repeat(16)}`) });
    if ('no' in key) throw new Error(key.no);
    const secret = await promote(app, token, directJob.id, { ...base, repo: PRIVATE_REPO, artifacts: [key.id], commit: [key.id], allowPersonalData: true });
    expect(secret.status).toBe(422);
    expect(secret.body.error).toMatch(/keys\.txt.*secret/);
    expect(github.files ?? {}).toEqual({});
    expect(github.issues.filter((i) => i.repo === REPO)).toEqual([]);
  });
});
