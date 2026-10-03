// The GitHub source in app mode: the installation is the allowlist, and hopper comments are
// told apart by the bot author (the marker is only a secondary check).

import { describe, expect, it } from 'vitest';
import { APP_INFO, BOT, REPO, discoverOne, jobForIssue, question, setup, setupApp } from './fixtures/github-support.ts';

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

  it('refuses an authors list containing the bot (its comments would read as answers)', async () => {
    const { gh, source } = setupApp({ authors: ['owner', BOT] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await expect(source.discover()).rejects.toThrow(/authors.*bot/);
  });
});

describe('app mode identity', () => {
  async function asked() {
    const s = setupApp();
    s.gh.createIssue({ repo: REPO, labels: ['hopper', 'hopper:claimed'] });
    const base = jobForIssue(1, { status: 'waiting_answer', questionId: 'q-1' }, REPO, 'github-app');
    const state = await s.source.report({ kind: 'question', job: base, question: question(base.id) });
    return { ...s, job: { ...base, sourceState: { source: state } } };
  }

  it('posts hopper comments as the bot', async () => {
    const { gh } = await asked();
    expect(gh.commentsOn(REPO, 1).map((c) => c.author)).toEqual([BOT]);
  });

  it('a bot comment is never an answer, even without a marker', async () => {
    const { gh, source, job } = await asked();
    gh.addComment(REPO, 1, BOT, 'plain text from the app');
    expect(await source.check([job])).toEqual([]);
  });

  it("the owner's reply without a marker is the answer", async () => {
    const { gh, source, job } = await asked();
    gh.addComment(REPO, 1, BOT, 'a job comment');
    const reply = gh.addComment(REPO, 1, 'owner', '  use postgres  ');
    expect(await source.check([job])).toEqual([
      { kind: 'answer', jobId: job.id, questionId: 'q-1', answer: 'use postgres', author: 'owner', url: reply.url },
    ]);
  });

  it("a marker-carrying comment by the owner is still excluded (secondary check)", async () => {
    const { gh, source, job } = await asked();
    gh.addComment(REPO, 1, 'owner', '<!-- job-hopper v1 kind=job-comment -->\nfrom a gh job');
    expect(await source.check([job])).toEqual([]);
  });

  it("reuse on retry finds the bot's comment and ignores a stranger's planted marker", async () => {
    const { gh, source } = setupApp();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const job = jobForIssue(1, {}, REPO, 'github-app');
    const marker = `<!-- job-hopper v1 kind=claimed job=${job.id} -->`;
    gh.addComment(REPO, 1, 'mallory', `${marker}\nplanted`);
    const first = await source.report({ kind: 'claimed', job });
    expect(gh.commentsOn(REPO, 1).find((c) => c.id === first.claimCommentId)?.author).toBe(BOT);
    const again = await source.report({ kind: 'claimed', job }); // a retry without the state
    expect(again.claimCommentId).toBe(first.claimCommentId);
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

describe('app mode job context and env', () => {
  it('tells the job to comment with HOPPER_COMMENT_CMD and never with gh', async () => {
    const { gh, source } = setupApp();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const { prompt } = await discoverOne(source);
    expect(prompt).toContain('"$HOPPER_COMMENT_CMD" "<your text>"');
    expect(prompt).toContain('Never comment with gh');
    expect(prompt).not.toContain('gh issue comment');
  });

  it('carries the token file, the comment command and the API base in the env', async () => {
    const { gh, source } = setupApp({}, {
      tokens: { pathFor: (url) => `/tokens/${url.length}.json`, ensure: async () => undefined, refresh: async () => undefined, drop: () => undefined, errors: () => ({}) },
    });
    const issue = gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect((await discoverOne(source)).env).toMatchObject({
      HOPPER_ISSUE_URL: issue.url, HOPPER_REPO: REPO, HOPPER_ISSUE_NUMBER: '1',
      HOPPER_COMMENT_MARKER: '<!-- job-hopper v1 kind=job-comment -->',
      HOPPER_TOKEN_FILE: `/tokens/${issue.url.length}.json`,
      HOPPER_COMMENT_CMD: '/opt/hopper/hopper-comment',
      HOPPER_GITHUB_API: 'http://127.0.0.1:9/api',
    });
  });

  it('gh mode keeps the phase-3 block and env', async () => {
    const { gh, source } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const item = await discoverOne(source);
    expect(item.prompt).toContain('gh issue comment "$HOPPER_ISSUE_NUMBER"');
    expect(Object.keys(item.env).sort()).toEqual(['HOPPER_COMMENT_MARKER', 'HOPPER_ISSUE_NUMBER', 'HOPPER_ISSUE_TITLE', 'HOPPER_ISSUE_URL', 'HOPPER_REPO']);
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
