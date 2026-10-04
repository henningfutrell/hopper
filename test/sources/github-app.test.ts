// The GitHub source in app mode: the installation is the allowlist, and hopper comments are
// told apart by the bot author (the marker is only a secondary check). It writes labels and one
// completion comment, as the bot.

import { describe, expect, it } from 'vitest';
import { APP_INFO, BOT, REPO, discoverOne, jobForIssue, setup, setupApp } from './fixtures/github-support.ts';

const OTHER = 'owner/other';
const methods = (calls: { method: string }[]) => calls.map((c) => c.method);

describe('app mode discovery', () => {
  it('scans only the repos the app is installed on', async () => {
    const { gh, source } = setupApp({}, { installed: [REPO] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: OTHER, labels: ['hopper'] });
    const items = await source.discover();
    expect(items.map((i) => i.repo)).toEqual([REPO]);
    expect(methods(gh.calls)).not.toContain('searchOpenIssues');
    expect(source.describe()).toMatchObject({ mode: 'app', installedRepos: [REPO] });
  });

  it('restricts to the intersection with config repos when they are set', async () => {
    const { gh, source } = setupApp({ repos: [OTHER, 'owner/not-installed'] }, { installed: [REPO, OTHER] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: OTHER, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.repo)).toEqual([OTHER]);
    expect(gh.calls.filter((c) => c.method === 'listOpenIssues').map((c) => c.args[0])).toEqual([OTHER]);
  });

  it('nothing installed → no items, a setup hint with the install link, and never a search', async () => {
    const { gh, source } = setupApp({}, { installed: [] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect(await source.discover()).toEqual([]);
    expect(methods(gh.calls)).not.toContain('searchOpenIssues');
    expect(methods(gh.calls)).not.toContain('whoami');
    expect(source.describe()).toMatchObject({
      setup: `install the app: ${APP_INFO.htmlUrl}/installations/new`, installedRepos: [],
    });
  });

  it('refuses an authors list containing the bot (its writes must never count as the owner\'s)', async () => {
    const { gh, source } = setupApp({ authors: ['owner', BOT] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await expect(source.discover()).rejects.toThrow(/authors.*bot/);
  });
});

describe('app mode identity', () => {
  it('posts the completion comment as the bot', async () => {
    const { gh, source } = setupApp();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.report({ kind: 'finished', job: jobForIssue(1, { status: 'finished', result: 'done' }, REPO, 'github-app') });
    expect(gh.commentsOn(REPO, 1).map((c) => c.author)).toEqual([BOT]);
  });

  it("reuse on retry finds the bot's comment and ignores a stranger's planted marker", async () => {
    const { gh, source } = setupApp();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const job = jobForIssue(1, { status: 'finished', result: 'done' }, REPO, 'github-app');
    const marker = `<!-- job-hopper v1 kind=finished job=${job.id} -->`;
    gh.addComment(REPO, 1, 'mallory', `${marker}\nplanted`);
    const first = await source.report({ kind: 'finished', job });
    expect(gh.commentsOn(REPO, 1).find((c) => c.id === first.finalCommentId)?.author).toBe(BOT);
    const again = await source.report({ kind: 'finished', job }); // a retry without the state
    expect(again.finalCommentId).toBe(first.finalCommentId);
    expect(gh.commentsOn(REPO, 1).filter((c) => c.author === BOT)).toHaveLength(1);
  });

  it('the job context excludes bot comments, marker or not', async () => {
    const { gh, source } = setupApp();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.addComment(REPO, 1, BOT, 'bot says hi');
    gh.addComment(REPO, 1, 'owner', 'a real note');
    const { prompt } = await discoverOne(source);
    expect(prompt).not.toContain('bot says hi');
    expect(prompt).toContain(': a real note');
  });
});

describe('job context and env: the issue, read-only', () => {
  it.each([['app', setupApp], ['gh', setup]] as const)('%s mode: no write path in the prompt or the env', async (_mode, make) => {
    const { gh, source } = make();
    const issue = gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const item = await discoverOne(source);
    expect(item.prompt).not.toMatch(/HOPPER_COMMENT|gh issue comment|how to report|read-only\]|comment on|status comment/);
    expect(item.env).toEqual({ HOPPER_ISSUE_URL: issue.url, HOPPER_REPO: REPO, HOPPER_ISSUE_NUMBER: '1', HOPPER_ISSUE_TITLE: 'Issue 1' });
  });
});

describe('describe (B4 fields)', () => {
  it('app source: name/kind github-app and the app fields', async () => {
    const { source } = setupApp();
    await source.discover();
    expect(source.name).toBe('github-app');
    expect(source.kind).toBe('github-app');
    expect(source.describe()).toMatchObject({
      mode: 'app', slug: APP_INFO.slug, htmlUrl: APP_INFO.htmlUrl,
      installUrl: `${APP_INFO.htmlUrl}/installations/new`, configUrl: 'https://github.com/settings/installations',
      installedRepos: [REPO], repos: [], authors: ['owner'], label: 'hopper', projectErrors: {},
    });
    expect(source.describe().setup).toBeUndefined();
  });

  it('app source without an app file: setup says to run the helper; a broken file is appError', () => {
    const missing = setupApp({}, { appInfo: () => ({ ok: false, reason: 'missing' }) }).source.describe();
    expect(missing.setup).toBe('run bash ~/.local/lib/job-hopper/scripts/create-github-app.sh');
    const broken = setupApp({}, { appInfo: () => ({ ok: false, reason: 'bad key' }) }).source.describe();
    expect(broken.appError).toBe('bad key');
  });

  it('carries the pause reason', () => {
    const { source } = setupApp({}, { paused: () => 'no GitHub App configured' });
    expect(source.describe().paused).toBe('no GitHub App configured');
  });

  it('gh source: mode gh and the enabled setting', () => {
    const { source } = setup();
    expect(source.kind).toBe('github');
    expect(source.describe()).toMatchObject({ mode: 'gh', enabledSetting: 'auto' }); // sources.yaml default (phase 4)
  });
});
