// Issue #1125: with no GitHub webhook, a new labelled issue reaches intake at the next sync, not after the intake sync
// interval. Between listings, each timed sync asks GitHub, with a conditional request, which issues of each job repository
// changed since its listing (a **change read**); a change the listing cache does not hold makes that repository due, so it
// is listed at once, as a GitHub delivery makes it. A change read that fails leaves the timed listing. A repository one
// source could not list is asked again by that source each interval, whatever another source's listing of it keeps fresh.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { memoryListings } from '../../src/sources/github/listing.ts';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import type { GitHubListingRepository } from '../../src/domain/github-listing.ts';
import type { Job } from '../../src/domain/types.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const MIN = 60_000;

function setup(o: { listings?: GitHubListingRepository; clock?: { at: number }; repos?: string[] } = {}) {
  const gh = createFakeGitHub();
  const clock = o.clock ?? { at: Date.parse('2026-10-14T18:00:00.000Z') };
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', api: gh, trust: testTrust(),
    config: githubConfig({ repos: o.repos ?? [REPO] }), clock: { now: () => new Date(clock.at) }, listingEveryMs: () => 15 * MIN,
    ...(o.listings ? { listings: o.listings } : {}),
  });
  const count = (method: string) => gh.calls.filter((c) => c.method === method).length;
  return { gh, source, count, pass: (ms: number) => { clock.at += ms; }, clock };
}

describe('the change read (issue #1125)', () => {
  it('a new labelled issue inside the interval is listed and taken at the next timed sync', async () => {
    const { gh, source, count, pass } = setup();
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    pass(MIN);
    expect((await source.discover({ due: true })).map((i) => i.number)).toEqual([1]);
    expect(count('listRepos')).toBe(2);
    expect(count('issuesChangedSince')).toBe(1);
  });

  it('a new labelled issue not assigned to the user shows in intake with its reason', async () => {
    const { gh, source, pass } = setup();
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'], assignees: [] });
    pass(MIN);
    await source.discover({ due: true });
    expect(source.intake!().map((x) => [x.key, x.reason])).toEqual([[`https://github.com/${REPO}/issues/1`, 'not assigned to you']]);
  });

  it('an unchanged repository is not listed again inside the interval', async () => {
    const { gh, source, count, pass } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover({ due: true });
    pass(MIN);
    await source.discover({ due: true });
    pass(MIN);
    await source.discover({ due: true });
    expect(count('listRepos')).toBe(1);
    expect(count('issuesChangedSince')).toBe(2);
  });

  it('asks from the newest change the listing holds, as GitHub dates it', async () => {
    const { gh, source, pass } = setup();
    const issue = gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover({ due: true });
    pass(MIN);
    await source.discover({ due: true });
    expect(gh.calls.filter((c) => c.method === 'issuesChangedSince').map((c) => c.args)).toEqual([[REPO, issue.updatedAt]]);
  });

  it('an issue without the label, and not listed, changes nothing', async () => {
    const { gh, source, count, pass } = setup();
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: [] });
    pass(MIN);
    await source.discover({ due: true });
    expect(count('listRepos')).toBe(1);
  });

  it('a listed issue closed or unlabelled makes the repository due: intake drops it', async () => {
    for (const change of ['close', 'unlabel'] as const) {
      const { gh, source, count, pass } = setup();
      gh.createIssue({ repo: REPO, labels: ['hopper'] });
      await source.discover({ due: true });
      if (change === 'close') gh.closeIssue(REPO, 1);
      else gh.removeLabel(REPO, 1, 'hopper');
      pass(MIN);
      await source.discover({ due: true });
      expect([change, count('listRepos')]).toEqual([change, 2]);
      expect([change, source.intake!()]).toEqual([change, []]);
    }
  });

  it('a listed issue edited is read again from GitHub, with no new listing', async () => {
    const { gh, source, count, pass } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover({ due: true });
    gh.editIssue(REPO, 1, { body: 'Do the other thing.' }, 'owner', '2026-10-14T18:00:30.000Z');
    pass(MIN);
    expect((await source.discover({ due: true })).map((i) => i.body)).toEqual(['Do the other thing.']);
    expect(count('listRepos')).toBe(1);
  });

  it("the hopper's own label write is no reason to list again", async () => {
    const { gh, source, count, pass } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover({ due: true });
    await source.report({ kind: 'claimed', job: { id: 'job-1', status: 'running', source: { source: 'github', key: `https://github.com/${REPO}/issues/1`, repo: REPO, number: 1, assignee: 'owner' } } as unknown as Job });
    expect(gh.issue(REPO, 1).labels).toContain('hopper:claimed');
    pass(MIN);
    await source.discover({ due: true });
    expect(count('listRepos')).toBe(1);
  });

  it('a change read that fails leaves the timed listing: the sync goes on', async () => {
    const { gh, source, count, pass } = setup();
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.failNext('issuesChangedSince', new GitHubApiError('rate limited', false, 429));
    pass(MIN);
    expect(await source.discover({ due: true })).toEqual([]);
    expect(count('listRepos')).toBe(1);
    pass(MIN);
    expect((await source.discover({ due: true })).map((i) => i.number)).toEqual([1]);
  });

  it('a sync a person asked for lists at once, with no change read', async () => {
    const { source, count } = setup();
    await source.discover({ due: true });
    await source.discover();
    expect(count('listRepos')).toBe(2);
    expect(count('issuesChangedSince')).toBe(0);
  });
});

describe('a repository one source could not list (issue #1125)', () => {
  it('is asked again each interval, though another source keeps the shared listing fresh', async () => {
    const listings = memoryListings();
    const clock = { at: Date.parse('2026-10-14T18:00:00.000Z') };
    const a = setup({ listings, clock, repos: [REPO, 'owner/other'] });
    const b = setup({ listings, clock });
    a.gh.failRepo(REPO, 'Resource not accessible by integration');
    b.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    a.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await a.source.discover({ due: true });
    await b.source.discover({ due: true });
    expect(a.source.describe().repoErrors).toEqual({ [REPO]: 'Resource not accessible by integration' });
    a.gh.failRepo(REPO, undefined);
    a.pass(15 * MIN);
    await b.source.discover({ due: true });
    expect((await a.source.discover({ due: true })).map((i) => i.number)).toEqual([1]);
    expect(a.gh.calls.filter((c) => c.method === 'listRepos').map((c) => c.args[0])).toEqual([[REPO, 'owner/other'], [REPO, 'owner/other']]);
    expect(a.source.describe().repoErrors).toBeUndefined();
  });
});
