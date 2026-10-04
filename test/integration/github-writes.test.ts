// What the hopper may write to an issue (owner decision, 2026-10-04: labels only, no comment).
// Through the real daemon, against the fake GitHub: the only writes are labels (state). No
// comment at all: not claim, progress, question, answered, failure, cancel or completion; a
// question goes to the owner through the UI, never onto the issue, and a reply on the issue is not
// an answer. Jobs get no way to write to their issue (no token file, no comment helper).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/app/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { APP_ID, BOT, KEYS, SLUG, appSecrets, jobSourcesDoc } from '../support/github-app.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/job-hopper-sandbox';
const WRITES = new Set(['comment', 'editComment', 'mintRepoToken']);
const LABEL_WRITES = ['ensureLabel', 'addLabels', 'removeLabels'];
const labelCalls = (gh: FakeGitHub) => gh.calls.filter((c) => LABEL_WRITES.includes(c.method));

const apps: TestApp[] = [];
const servers: FakeGitHubServer[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const c of cleanups.splice(0)) c();
});

type Mode = 'gh' | 'app';

async function boot(mode: Mode, gh: FakeGitHub | undefined, app: Record<string, unknown> = {}) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const jobSources = mode === 'gh'
    ? jobSourcesDoc({ github: { enabled: true, repos: [REPO], appKeyEnv: null }, githubApp: { enabled: false } })
    : jobSourcesDoc({ github: false, githubApp: app });
  const seams = gh === undefined ? {} : mode === 'gh' ? { github: gh } : { githubApp: gh };
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { jobSources }, seams, secrets: mode === 'app' ? appSecrets() : {} });
  apps.push(a);
  return a;
}

const fakeFor = (mode: Mode) => (mode === 'gh' ? createFakeGitHub() : createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } }));
const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);
const writesTo = (gh: FakeGitHub) => gh.calls.filter((c) => WRITES.has(c.method));

describe.each<Mode>(['gh', 'app'])('issue writes (%s source)', (mode) => {
  it('claim → progress → question → answer in the UI → finished: labels only, zero comments', async () => {
    const gh = fakeFor(mode);
    const a = await boot(mode, gh);
    const issue = gh.createIssue({ repo: REPO, title: 'Risky thing', body: body({ op: 'ask', message: 'Is this risky?', progress: [0.25, 0.5] }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'claimed label' });

    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect((await a.events('types=job.progressed')).filter((e) => e.jobId === job.id)).not.toHaveLength(0);
    const escalated = (await a.events('types=question.escalated')).find((e: DomainEvent) => e.questionId === q.id && e.data.target === 'human')!;
    expect(escalated.data.answerUrl).toBe(`${a.url}/#question-${q.id}`);

    // The owner's reply on the issue is not an answer: there is no question comment to reply to.
    gh.addComment(REPO, issue.number, 'owner', 'go ahead from the issue');
    await a.sync();
    expect((await a.job(job.id)).status).toBe('waiting_answer');
    expect(writesTo(gh)).toEqual([]);

    const token = await a.login();
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'go ahead' }, { token })).status).toBe(200);
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'go ahead' });
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:claimed');
    await a.sync();

    expect(gh.commentsOn(REPO, issue.number).filter((c) => c.body !== 'go ahead from the issue')).toEqual([]);
    expect(writesTo(gh)).toEqual([]);
    const added = labelCalls(gh).filter((c) => c.method === 'addLabels').map((c) => (c.args[2] as string[]).join(','));
    expect(added).toEqual(['hopper:claimed', 'hopper:done']);
    expect(labelCalls(gh).filter((c) => c.method === 'removeLabels').map((c) => (c.args[2] as string[]).join(','))).toEqual(['hopper:claimed']);
  });

  it('a failed job: labels hopper:failed, zero comments', async () => {
    const gh = fakeFor(mode);
    const a = await boot(mode, gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', message: 'boom', progress: [0.5] }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'failed');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:claimed');
    await a.sync();
    expect(gh.commentsOn(REPO, issue.number)).toEqual([]);
    expect(writesTo(gh)).toEqual([]);
  });

  it('a cancelled job (issue closed): claimed label removed, zero comments', async () => {
    const gh = fakeFor(mode);
    const a = await boot(mode, gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'running');
    gh.closeIssue(REPO, issue.number);
    await a.sync();
    await a.waitForStatus(job.id, 'cancelled');
    await waitFor(() => !gh.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'claimed label removed' });
    expect(gh.commentsOn(REPO, issue.number)).toEqual([]);
    expect(writesTo(gh)).toEqual([]);
  });

  it('the job gets its issue read-only: no token file, no comment helper, no comment instructions', async () => {
    const gh = fakeFor(mode);
    const a = await boot(mode, gh);
    const issue = gh.createIssue({ repo: REPO, title: 'Echo it', body: body({ op: 'echo', message: 'hi' }), labels: ['hopper'] });
    gh.addComment(REPO, issue.number, 'owner', 'context from the owner');
    await a.sync();
    const job = (await jobFor(a, issue.url))!;
    await a.waitForStatus(job.id, 'finished');
    const payload = a.scripted.payloads.find((p) => (p.env as Record<string, string>).HOPPER_ISSUE_URL === issue.url)!;
    expect(payload.env).toEqual({
      HOPPER_ISSUE_URL: issue.url, HOPPER_REPO: REPO, HOPPER_ISSUE_NUMBER: String(issue.number), HOPPER_ISSUE_TITLE: 'Echo it',
    });
    const prompt = String(payload.prompt);
    expect(prompt).toContain('[job-hopper issue context]');
    expect(prompt).toContain(`url: ${issue.url}`);
    expect(prompt).toContain('context from the owner');
    expect(prompt).not.toContain('[how to report on your issue]');
    expect(prompt).not.toMatch(/HOPPER_COMMENT|hopper-comment|gh issue comment/);
    expect(prompt).not.toMatch(/read-only\]|comment on|status comment/);
    expect(existsSync(join(dirname(a.dbPath), 'job-tokens'))).toBe(false);
  });
});

describe('issue writes through HTTP (node:http fake GitHub, real App adapter)', () => {
  it('only label writes reach GitHub, no comment POST; no repo-scoped token is minted', async () => {
    const fake = await createFakeGitHubServer({
      appId: APP_ID, publicKeyPem: KEYS.publicKey, slug: SLUG,
      installations: [{ id: 7, account: 'owner', repos: [{ owner: 'owner', name: 'job-hopper-sandbox', labels: ['hopper'], issues: [
        { number: 1, title: 'Risky thing', author: 'owner', labels: ['hopper'], body: body({ op: 'ask', message: 'Is this risky?', progress: [0.5] }) },
      ] }] }],
    });
    servers.push(fake);
    const a = await boot('app', undefined, { apiUrl: fake.url });
    const issue = fake.state.repos.get(REPO)!.issues.get(1)!;
    await a.sync();
    const job = (await jobFor(a, `https://github.com/${REPO}/issues/1`))!;
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    await a.sync();
    expect(issue.comments).toEqual([]);

    const token = await a.login();
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'go ahead' }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished');
    await waitFor(() => issue.labels.includes('hopper:done'), { what: 'hopper:done' });
    await a.sync();

    expect(issue.comments).toEqual([]);
    const writes = fake.state.requests
      .filter((r) => r.method !== 'GET' && !r.path.startsWith('/app/') && !r.path.startsWith('/graphql'))
      .map((r) => `${r.method} ${r.path.replace(/\/labels\/.+$/, '/labels/:name')}`);
    expect(writes.filter((w) => !/\/labels(\/:name)?$/.test(w))).toEqual([]);
    expect(writes.some((w) => /comments/.test(w))).toBe(false);
    expect(writes.filter((w) => w.endsWith('/issues/1/labels'))).toEqual([`POST /repos/${REPO}/issues/1/labels`, `POST /repos/${REPO}/issues/1/labels`]);
    expect(writes.filter((w) => w.endsWith('/labels/:name'))).toEqual([`DELETE /repos/${REPO}/issues/1/labels/:name`]);
    expect(fake.state.tokens.some((t) => t.body.permissions !== undefined || t.body.repositories !== undefined)).toBe(false);
  });
});
