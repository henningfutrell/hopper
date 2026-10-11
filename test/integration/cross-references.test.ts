// Cross-reference detection (issue #430): a done job that follows its pull request keeps the links of its issue on the
// job (`sourceState.source.links`) — every pull request and commit, of its repository or another, that closes the issue
// with a closing keyword and that GitHub confirms. A text reference GitHub does not treat as closing is not linked. The
// links are asked again at each sync while the job follows its pull request. Real daemon, real database; the in-memory
// fake GitHub at the GitHubApi seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const OTHER = 'owner/other';
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
  connectGitHub(a, [REPO, OTHER]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const now = () => new Date().toISOString();
const jobFor = async (app: TestApp, url: string): Promise<Job> =>
  (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url)!;
const linksOf = async (app: TestApp, id: string) => ((await app.job(id)).sourceState?.source as { links?: unknown } | undefined)?.links;

describe('cross-reference detection (issue #430)', () => {
  it('a followed job keeps its issue\'s confirmed closing links, same repository and another; a mention and an unconfirmed keyword are not linked', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    let own = '';
    app.scripted.ships((job) => {
      if (job.source?.key === issue.url) own = gh.mentionIssue(REPO, issue.number, { text: `Closes #${issue.number}`, closes: true, createdAt: now() });
    });
    await app.sync();
    const job = await app.waitForStatus((await jobFor(app, issue.url)).id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });

    const other = gh.mentionIssue(REPO, issue.number, { from: OTHER, text: `Fixes ${REPO}#${issue.number}`, closes: true, createdAt: now() });
    gh.mentionIssue(REPO, issue.number, { text: `Refs #${issue.number}`, closes: false, createdAt: now() });
    gh.mentionIssue(REPO, issue.number, { text: `Resolves #${issue.number}`, closes: false, createdAt: now() });
    await app.sync();

    const links = await waitFor(async () => { const l = await linksOf(app, job.id); return Array.isArray(l) && l.length === 2 ? l : undefined; }, { what: 'the links on the job' });
    expect(links).toEqual([
      { kind: 'pull_request', repo: REPO, url: own, keyword: 'closes' },
      { kind: 'pull_request', repo: OTHER, url: other, keyword: 'fixes' },
    ]);
  });
});
