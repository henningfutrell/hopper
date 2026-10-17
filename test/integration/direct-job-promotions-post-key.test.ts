// Issue #1591: Promote to GitHub never posts twice. The promotion's send is kept before GitHub is asked, its post key in
// the text; before a create the hopper looks for that key on GitHub. A retry after a timeout, or a start after a stop,
// links what GitHub made. The daemon, store and HTTP edge are real; GitHub is a fake on loopback
// (test/support/fake-forges.ts), and its answer to a create is lost to simulate the stop or the timeout.
//
// Feature: Promote to GitHub, posted once
//   Scenario: GitHub made the issue, the answer was lost, and the person promotes again
//     Given GitHub makes the new issue, but the hopper reads 502
//     When the person promotes the direct job, and then again
//     Then one issue exists, with the text of the second try, and the promotion links it
//   Scenario: the hopper stopped after GitHub made the issue, before the promotion's row
//     Given GitHub made the issue, and the hopper stopped before it kept the promotion
//     When the hopper starts again
//     Then one issue exists, and the promotion links it
//   Scenario: a comment too
//     Given GitHub adds the comment, but the hopper reads 502
//     When the person promotes again
//     Then one comment exists, and the promotion links it
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

const REPO = 'octo-org/ops';

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'promoter');
  github.privateRepos = [REPO];
  github.issues.push({ repo: REPO, number: 4, title: 'Sign-in lockouts', body: '', author: 'someone', labels: [] });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const env = { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' };
  const boot = async () => {
    const app = await startTestApp({ dbPath: db.dbPath, env });
    apps.push(app);
    return { app, token: await app.login() };
  };
  const first = await boot();
  connectGitHub(first.app, [REPO], { login: 'promoter' });
  const r = await first.app.ui<{ directJob: DirectJobView; job: { id: string } }>('/ui/api/direct-jobs', {
    title: 'Why was a sign-in locked?', brief: `${JSON.stringify({ op: 'echo', message: 'A lockout.' })}\nFind out why.`,
    labels: [], authorizations: [], executor: 'scripted', repo: REPO,
  }, { token: first.token });
  expect(r.status).toBe(200);
  await first.app.waitForStatus(r.body.job.id, 'finished');
  return { github, ...first, boot, id: r.body.directJob.id };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
type Answer = { status: number; body: any };
const promote = (app: TestApp, token: string, id: string, body: Record<string, unknown>): Promise<Answer> => app.ui(`/ui/api/direct-jobs/${id}/promotion`, body, { token });
const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);
const issuesOf = (github: Awaited<ReturnType<typeof createFakeGitHub>>) => github.issues.filter((i) => i.repo === REPO && i.number !== 4);
const DRAFT = { repo: REPO, target: { kind: 'issue' }, title: 'Lockouts', body: 'First take.', labels: [], artifacts: [] };

describe('Promote to GitHub posts once (issue #1591)', () => {
  it('links the issue GitHub made when its answer was lost, at the next promotion', async () => {
    const { app, github, token, id } = await start();
    github.answerLost = 502;
    expect((await promote(app, token, id, DRAFT)).status).toBe(502);
    expect(issuesOf(github)).toHaveLength(1);

    github.answerLost = undefined;
    const again = await promote(app, token, id, { ...DRAFT, body: 'Second take.' });
    expect(again.status).toBe(200);
    const issues = issuesOf(github);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain('Second take.');
    expect(again.body).toMatchObject({ kind: 'issue', number: issues[0]!.number });
    expect((await app.api<DirectJobView>('GET', `/api/direct-jobs/${id}`)).body.promotion).toMatchObject({ number: issues[0]!.number });
  });

  it('links the issue GitHub made before the hopper stopped, at the next start', async () => {
    const { app, github, token, id, boot } = await start();
    github.answerLost = 502;
    expect((await promote(app, token, id, DRAFT)).status).toBe(502);
    github.answerLost = undefined;
    await app.stop();

    const again = await boot();
    const linked = await waitFor(async () => (await again.app.api<DirectJobView>('GET', `/api/direct-jobs/${id}`)).body.promotion, { what: 'the promotion linked' });
    const issues = issuesOf(github);
    expect(issues).toHaveLength(1);
    expect(linked).toMatchObject({ repo: REPO, kind: 'issue', number: issues[0]!.number });
    expect(eventsOf(again.app, 'direct_job.promoted').map((e) => e.data.number)).toEqual([issues[0]!.number]);
  });

  it('adds a comment once when its answer was lost', async () => {
    const { app, github, token, id } = await start();
    const draft = { ...DRAFT, target: { kind: 'comment', number: 4 } };
    github.answerLost = 502;
    expect((await promote(app, token, id, draft)).status).toBe(502);
    github.answerLost = undefined;
    const again = await promote(app, token, id, { ...draft, body: 'Second take.' });
    expect(again.status).toBe(200);
    const comments = github.issues.find((i) => i.repo === REPO && i.number === 4)!.comments!;
    expect(comments).toHaveLength(1);
    expect(String(comments[0]!.body)).toContain('Second take.');
    expect(again.body).toMatchObject({ kind: 'comment', number: 4, url: comments[0]!.html_url });
  });
});
