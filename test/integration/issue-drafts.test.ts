// Issue #471: File an issue. The person describes a problem, their own signed-in Claude drafts the issue, they read and
// edit it, and only on their confirmation is it filed, with their own GitHub connection, on one of their job
// repositories, with no label and no assignee. The daemon, store and HTTP edge are real; the drafter is a double at its
// seam (UserSeams.issueDrafter) and GitHub a fake on loopback (test/support/fake-forges.ts).
//
// Feature: File an issue
//   Scenario: a job attached as context, a draft, the confirm step, then the issue filed as the person
//     Given a GitHub connection with one job repository, and a drafter
//     When the person attaches a failed job's context and asks for a draft
//     Then the draft comes back, and nothing is on GitHub yet
//     When the person files it without the confirmation
//     Then it is refused, and nothing is on GitHub
//     When the person confirms the confirm step
//     Then the issue is filed with the person's own token, no label, no assignee, the note last
//     And issue_draft.filed is on the job's timeline, without the text
//   Scenario: a viewer is refused by the daemon, whatever the UI shows
//   Scenario: with no provider, the status says why, and a draft is refused
import { afterEach, describe, expect, it } from 'vitest';
import { FILED_NOTE } from '../../src/domain/issue-drafts.ts';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import type { IssueDrafter } from '../../src/issue-drafts/index.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'octo-org/ops';

const DRAFTER: IssueDrafter = {
  provider: 'claude',
  available: async () => ({ ok: true }),
  draft: async (_skill, input) => ({
    title: 'Sign-in locks out after two tries', notes: 'Rephrased.', model: 'claude-sonnet-5-5',
    body: `## Summary\nTwo failed sign-ins lock the account.\n\nSeen with: ${input.context?.includes('Job:') ? 'a job' : 'no job'}`,
  }),
};

async function start(o: { drafter?: IssueDrafter; viewer?: boolean } = {}) {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'filer');
  github.privateRepos = [REPO];
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  if (o.viewer) writeConfig(db.dbPath, 'sign-in', { version: 1, none: { role: 'viewer' } });
  const app = await startTestApp({
    dbPath: db.dbPath,
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    seams: { issueDrafter: o.drafter ?? DRAFTER },
  });
  apps.push(app);
  connectGitHub(app, [REPO], { login: 'filer' });
  const token = o.viewer ? (await app.ui<{ token: string }>('/ui/auth/none', {})).body.token : await app.login();
  return { app, github, token };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any };

describe('File an issue (issue #471)', () => {
  it('attaches a job, drafts, checks, and files only on confirmation, as the person, with no label and no assignee', async () => {
    const { app, github, token } = await start();
    const status = await app.api('GET', '/api/issue-drafts', undefined, { 'x-hopper-session': token });
    expect(status.body).toEqual({ provider: 'claude', available: true, usable: true, repos: [REPO] });

    const job = await app.pull({ op: 'fail', message: 'lockout after two tries' });
    await app.waitForStatus(job.id, 'failed');
    const ctx: Answer = await app.ui('/ui/api/issue-drafts/context', { jobId: job.id }, { token });
    expect(ctx.status).toBe(200);
    expect(ctx.body.context).toContain(`- Job: ${job.id} (failed)`);

    const ask = { repo: REPO, text: 'People get locked out after two failed sign-ins.', context: ctx.body.context };
    const prompt: Answer = await app.ui('/ui/api/issue-drafts/prompt', ask, { token });
    expect(prompt.body.prompt).toContain(ask.text);
    expect(prompt.body.prompt).toContain(`- Job: ${job.id} (failed)`);

    const draft: Answer = await app.ui('/ui/api/issue-drafts/draft', ask, { token });
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ repo: REPO, title: 'Sign-in locks out after two tries', notes: 'Rephrased.', provider: 'claude', skill: expect.stringMatching(/^file-issue@[0-9a-f]{16}$/), findings: [] });
    expect(draft.body.body).toContain('Seen with: a job');
    expect(github.issues.filter((i) => i.repo === REPO)).toEqual([]);

    const edited = { repo: REPO, title: draft.body.title, body: `${draft.body.body}\n\nEdited by the person.`, jobId: job.id };
    const unconfirmed: Answer = await app.ui('/ui/api/issue-drafts', edited, { token });
    expect(unconfirmed.status).toBe(400);
    expect(github.issues.filter((i) => i.repo === REPO)).toEqual([]);

    const check: Answer = await app.ui('/ui/api/issue-drafts/check', { repo: REPO, title: edited.title, body: edited.body }, { token });
    expect(check.body).toMatchObject({ repo: REPO, visibility: 'private', labels: [], assignees: [], findings: [] });

    const filed: Answer = await app.ui('/ui/api/issue-drafts', { ...edited, confirmed: true }, { token });
    expect(filed.status).toBe(200);
    const issue = github.issues.find((i) => i.repo === REPO)!;
    expect(issue).toMatchObject({ title: 'Sign-in locks out after two tries', author: 'filer', labels: [], assignees: [] });
    expect(issue.body).toContain('Edited by the person.');
    expect(issue.body).toContain(`${FILED_NOTE}\n\n<!-- hopper post `);
    expect(issue.body).toMatch(/<!-- hopper post [0-9a-f]{24} -->$/);
    const create = github.requests.find((q) => q.method === 'POST' && q.path.endsWith(`/repos/${REPO}/issues`))!;
    expect(create.auth).toContain('test-account-token');
    expect(filed.body).toEqual({ repo: REPO, number: issue.number, url: `${github.url}/${REPO}/issues/${issue.number}` });

    const [event] = eventsOf(app, 'issue_draft.filed');
    expect(event).toMatchObject({ jobId: job.id, data: { repo: REPO, number: issue.number, url: filed.body.url, by: expect.any(String), provider: 'claude', skill: draft.body.skill } });
    expect(JSON.stringify(eventsOf(app, 'issue_draft.drafted'))).not.toContain('locked out');
  });

  it('refuses a viewer at the daemon: no draft, no filing', async () => {
    const { app, github, token } = await start({ viewer: true });
    const draft: Answer = await app.ui('/ui/api/issue-drafts/draft', { repo: REPO, text: 'x' }, { token });
    expect(draft.status).toBe(403);
    const filed: Answer = await app.ui('/ui/api/issue-drafts', { repo: REPO, title: 't', body: 'b', confirmed: true }, { token });
    expect(filed.status).toBe(403);
    expect(github.issues.filter((i) => i.repo === REPO)).toEqual([]);
  });

  it('with no provider, says why, and refuses a draft', async () => {
    const { app, token } = await start({ drafter: { ...DRAFTER, available: async () => ({ ok: false, reason: 'Claude is not installed' }) } });
    const status = await app.api('GET', '/api/issue-drafts', undefined, { 'x-hopper-session': token });
    expect(status.body).toMatchObject({ available: false, usable: false, reason: 'Claude is not installed' });
    const draft: Answer = await app.ui('/ui/api/issue-drafts/draft', { repo: REPO, text: 'x' }, { token });
    expect(draft.status).toBe(409);
    expect(draft.body.error).toBe('Claude is not installed');
  });
});
