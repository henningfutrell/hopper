// A GitLab source (issue #1448 part 2, design.md "A GitLab source"), through the real daemon, store and HTTP edge; GitLab is
// a fake on loopback (test/support/fake-gitlab.ts).
//
// Feature: a GitLab source
//   Scenario: a user connects GitLab with a personal access token and picks projects; the hopper adds the GitLab source, and
//     Intake lists the labelled open issues of the picked projects, each with why it is not taken; nothing is written to GitLab
//   Scenario: the token is never answered; no account to pick for is not found; removing the account removes its source
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceStatus } from '../../src/domain/types.ts';
import type { GitLabAccountStatus } from '../../src/domain/gitlab-account.ts';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import { NOT_TAKEN_YET } from '../../src/gitlab/source.ts';
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
      { project: 'ada/tools', iid: 1, title: 'Fix the parser', author: 'ada', assignees: ['ada'], labels: ['hopper'] },
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
  it('lists the labelled open issues of the picked projects in Intake, through the GitLab account\'s token', async () => {
    const { app, gitlab } = await setup();
    const token = await app.login();
    expect(await gitlabSource(app)).toBeUndefined();
    const connected = await post(app, token, { action: 'connect', token: 'glpat-ada', baseUrl: gitlab.url });
    expect(connected.body.account).toMatchObject({ state: 'connected', account: 'ada', reached: ['ada/tools', 'acme/api'], projects: [] });
    const paused = await waitFor(async () => { const s = await gitlabSource(app); return typeof s?.detail.paused === 'string' ? s : undefined; }, { what: 'the GitLab source' });
    expect(paused.detail.paused).toContain('no GitLab project is picked');

    expect((await post(app, token, { action: 'choose', projects: ['ada/tools'] })).body.account).toMatchObject({ projects: ['ada/tools'] });
    const listed = await waitFor(async () => { const s = await gitlabSource(app); const i = s?.detail.intake as IntakeOutcome[] | undefined; return i?.length ? i : undefined; }, { what: 'Intake to list the GitLab issue' });
    expect(listed).toEqual([{ key: `${gitlab.url}/ada/tools/-/issues/1`, title: 'Fix the parser', repo: 'ada/tools', reason: NOT_TAKEN_YET, group: 'other' }]);
    expect(gitlab.requests.every((r) => r.token === 'glpat-ada')).toBe(true);
    expect(gitlab.requests.some((r) => r.path.includes('acme%2Fapi/issues'))).toBe(false);
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
