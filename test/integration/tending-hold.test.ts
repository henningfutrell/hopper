// A merged pull request holds nothing (issue #1162): a tend job whose pull request a person merged while it worked finished
// following nothing, and held its tending queue. Real daemon, in-memory fake GitHub at the GitHubApi seam; issues carry a
// scripted-executor op as their first body line.
// A tend job on its own command holds nothing (issue #1210): with lanes free, a pull request held behind it is tended at the
// next sync pass, not after `MAX_HELD_MS`.
import { afterEach, describe, expect, it } from 'vitest';
import type { PullRequestsView } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { nextJobOf, sourceOf, tends, waitingPullRequests, type Waiting } from '../support/tending.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
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
  connectGitHub(a, [REPO]);
  return a;
}

describe('a merged pull request holds nothing (issue #1162)', () => {
  it('the head merges while its tend job works on it: on the next pass the hold goes, and the next one is tended', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const merged: { head?: Waiting } = {};
    // The tend of the head: a person merges the pull request meanwhile, which closes its issue.
    const [first, second] = await waitingPullRequests(gh, app, REPO, 2, {
      tend: (url) => { if (url === merged.head?.url) { gh.mergePullRequest(url); gh.closeIssue(REPO, merged.head.issue); } },
    });
    merged.head = first;
    gh.setConflicting(first!.url, true);
    gh.setConflicting(second!.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase']]);
    const next = await nextJobOf(app, first!.job.id);
    await app.waitForStatus(next, 'finished');
    const held = (await app.api<PullRequestsView>('GET', '/api/pull-requests')).body.repos.flatMap((r) => r.pullRequests).find((c) => c.jobId === second!.job.id);
    expect(held?.queue).toMatchObject({ held: { pullRequest: Number(first!.url.split('/').at(-1)), why: 'tending' } });
    await app.sync();
    await waitFor(async () => (await tends(app)).length === 2, { what: 'the next one tended' });
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase'], [second!.job.id, 'rebase']]);
    expect(sourceOf(await app.job(second!.job.id))?.heldBehind).toBeUndefined();
  });
});

describe('a tend job on its own command holds nothing (issue #1210)', () => {
  it('the head\'s tend job waits on its own poll: on the next pass the one held behind it is tended', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const [first, second] = await waitingPullRequests(gh, app, REPO, 2);
    // The tend of the head waits on its own background command, as one that polls another pull request in a sleep loop.
    app.scripted.waits((j) => j.source?.key === gh.issue(REPO, first!.issue).url && j.id !== first!.job.id
      ? { for: 'the other pull request to become mergeable', until: 'background command b7x2 ends' } : undefined);
    gh.setConflicting(first!.url, true);
    gh.setConflicting(second!.url, true);
    await app.sync();
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase']]);
    const next = await nextJobOf(app, first!.job.id);
    await app.waitForStatus(next, 'waiting_on');
    expect((await app.job(next)).wait).toMatchObject({ ownCommand: true, on: { kind: 'own_command' } });
    expect(sourceOf(await app.job(second!.job.id))?.heldBehind).toMatchObject({ pullRequest: first!.url, why: 'tending' });
    await app.sync();
    await waitFor(async () => (await tends(app)).length === 2, { what: 'the one held behind the polling head tended' });
    expect(await tends(app)).toEqual([[first!.job.id, 'rebase'], [second!.job.id, 'rebase']]);
    expect(sourceOf(await app.job(second!.job.id))?.heldBehind).toBeUndefined();
  });
});
