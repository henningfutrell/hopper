// Issue #655, part 19: the rest of an issue's origin a job keeps — the pull requests its text names (who wrote each,
// whether its head is a fork, whether a trusted actor wrote it) and its repository's visibility. Read at intake with the
// origin, kept with the job, shown in the stamp view, given to Jev's trust check. No rule reads them. Through the real
// daemon, the fake GitHub at its seam and the OpenFGA double.
//
// Feature: linked pull requests and the repository's visibility
//   Scenario: the user's issue names a stranger's fork pull request and the user's own one
//     Given a public repository, and an issue the user wrote, labelled and assigned, whose body names both
//     When a sync takes it
//     Then its job is at owner, and keeps both, the stranger's marked a fork by no trusted actor, and the visibility public
//   Scenario: a name that is an issue, or that cannot be read
//     Then an issue is not kept, and a pull request that cannot be read is kept as not read
import { afterEach, describe, expect, it } from 'vitest';
import type { StampView } from '../../src/domain/stamp-view.ts';
import type { Job } from '../../src/domain/types.ts';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobs = async (a: TestApp) => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const jobOf = (a: TestApp, url: string) => waitFor(async () => (await jobs(a)).find((j) => j.source?.key === url), { what: 'the job' });

describe('linked pull requests and the repository\'s visibility (issue #655, part 19)', () => {
  it('keeps a stranger\'s fork pull request and the user\'s own one, and the visibility; the level stays owner', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    gh.setVisibility(REPO, 'public');
    const fork = gh.addPullRequestBy(REPO, 'stranger', { fork: true });
    const own = gh.addPullRequestBy('owner/other', 'owner');
    const issue = gh.createIssue({ repo: REPO, author: 'owner', body: body(`Merge the change of #${fork.number}, then ${own.url}.`), labels: ['hopper'] });
    await a.sync();
    const job = await jobOf(a, issue.url);
    expect(job.source).toMatchObject({
      origin: 'trusted', visibility: 'public',
      linkedPulls: [{ url: fork.url, author: 'stranger', fork: true, trusted: false }, { url: own.url, author: 'owner', fork: false, trusted: true }],
    });
    const stamp = (await a.api<StampView>('GET', `/api/jobs/${job.id}/stamp`)).body;
    expect(stamp).toMatchObject({ level: 'owner', visibility: 'public', linkedPulls: job.source!.linkedPulls });
  });

  it('an issue it names is not kept; a pull request that cannot be read is kept as not read', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const other = gh.createIssue({ repo: REPO, author: 'owner', body: 'Another issue.' });
    const issue = gh.createIssue({ repo: REPO, author: 'owner', body: body(`See #${other.number} and owner/gone#5.`), labels: ['hopper'] });
    gh.failLinkedRead('owner/gone', 5, new GitHubApiError('gh: Bad Gateway (HTTP 502)', false, 502));
    await a.sync();
    const job = await jobOf(a, issue.url);
    expect(job.source).toMatchObject({ visibility: 'private', linkedPulls: [{ url: 'https://github.com/owner/gone/issues/5', trusted: false, unread: true }] });
  });
});
