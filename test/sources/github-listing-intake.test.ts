// Issue #985 part 2: intake reads its issues from the listing cache, and lists the repositories again only on its schedule.
// One repository listing reads every repository (never one REST listing per repository and label); a timed sync inside the
// interval lists nothing; a sync a person asked for lists at once. A job's reads of its issue (getIssue, listComments,
// subIssues) go to GitHub only when the listed `updatedAt` is newer than what was read, or when a write came after it.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const MIN = 60_000;
const OTHER = 'owner/other';
const THIRD = 'owner/third';

function setup(o: { repos?: string[]; known?: boolean } = {}) {
  const gh = createFakeGitHub();
  let now = Date.parse('2026-10-13T10:00:00.000Z');
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', api: gh, trust: testTrust(),
    config: githubConfig({ repos: o.repos ?? [REPO] }), clock: { now: () => new Date(now) }, listingEveryMs: () => 15 * MIN,
    ...(o.known ? { knownKeys: (keys: string[]) => new Set(keys) } : {}),
  });
  const count = (method: string) => gh.calls.filter((c) => c.method === method).length;
  return { gh, source, count, pass: (ms: number) => { now += ms; } };
}

const jobOf = (n: number, repo = REPO): Job => ({
  id: `job-${n}`, status: 'running', source: { source: 'github', key: `https://github.com/${repo}/issues/${n}`, repo, number: n, assignee: 'owner' },
} as unknown as Job);

describe('intake from the listing cache (issue #985)', () => {
  it('lists every repository in one listing, never one REST listing per repository', async () => {
    const { gh, source, count } = setup({ repos: [REPO, OTHER, THIRD] });
    for (const repo of [REPO, OTHER, THIRD]) gh.createIssue({ repo, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.repo).sort()).toEqual([OTHER, REPO, THIRD].sort());
    expect(gh.calls.filter((c) => c.method === 'listRepos').map((c) => c.args)).toEqual([[[REPO, OTHER, THIRD], ['hopper']]]);
    expect(count('listOpenIssues')).toBe(0);
  });

  it('a timed sync inside the interval lists nothing and takes from the cache; after it, lists again', async () => {
    const { gh, source, count, pass } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    pass(5 * MIN);
    expect((await source.discover({ due: true })).map((i) => i.number)).toEqual([1]);
    expect(count('listRepos')).toBe(1);
    pass(10 * MIN);
    expect((await source.discover({ due: true })).map((i) => i.number)).toEqual([1, 2]);
    expect(count('listRepos')).toBe(2);
    // Issue 1 did not change: its text and comments were read once.
    expect(gh.calls.filter((c) => c.method === 'listComments' && c.args[1] === 1)).toHaveLength(1);
    expect(gh.calls.filter((c) => c.method === 'getIssue' && c.args[1] === 1)).toHaveLength(1);
  });

  it('a sync a person asked for (not due) lists at once', async () => {
    const { gh, source, count } = setup();
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect((await source.discover()).map((i) => i.number)).toEqual([1]);
    expect(count('listRepos')).toBe(2);
  });

  it('a repository GitHub does not answer for is said, and asked again only at the next interval', async () => {
    const { gh, source, count, pass } = setup({ repos: [REPO, 'owner/gone'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.failRepo('owner/gone', 'Could not resolve to a Repository');
    expect((await source.discover({ due: true })).map((i) => i.number)).toEqual([1]);
    expect(source.describe().repoErrors).toEqual({ 'owner/gone': 'Could not resolve to a Repository' });
    pass(MIN);
    await source.discover({ due: true });
    expect(count('listRepos')).toBe(1);
    expect(source.describe().repoErrors).toEqual({ 'owner/gone': 'Could not resolve to a Repository' });
  });

  it("a job's reads of its issue come from the cache while the listed issue is unchanged", async () => {
    const { gh, source, count, pass } = setup({ known: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    pass(MIN);
    await source.check([jobOf(1)]);
    pass(MIN);
    await source.discover({ due: true });
    await source.check([jobOf(1)]);
    expect(count('getIssue')).toBe(1);
    // A change on GitHub makes the listed issue newer: the next listing reads it again.
    gh.addComment(REPO, 1, 'owner', 'one more thing');
    await source.discover();
    await source.check([jobOf(1)]);
    expect(count('getIssue')).toBe(2);
  });

  it('a write to the issue makes its next read go to GitHub', async () => {
    const { gh, source, count } = setup({ known: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    await source.report({ kind: 'claimed', job: jobOf(1) });
    await source.check([jobOf(1)]);
    expect(count('getIssue')).toBe(2);
  });

  it("a timed sync sees the hopper's own label writes, made after the listing", async () => {
    const { gh, source, count } = setup();
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    expect(await source.discover({ due: true })).toHaveLength(1);
    await source.report({ kind: 'claimed', job: jobOf(1) });
    // No job here is known to hold the claim: the claimed issue is not offered again.
    expect(await source.discover({ due: true })).toEqual([]);
    expect(count('listRepos')).toBe(1);
  });

  it('an issue no longer listed (closed, unlabelled) is read from GitHub', async () => {
    const { gh, source, count } = setup({ known: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await source.discover();
    gh.closeIssue(REPO, 1);
    await source.discover();
    expect(await source.check([jobOf(1)])).toEqual([{ kind: 'cancel', jobId: 'job-1', reason: 'issue closed' }]);
    expect(count('getIssue')).toBe(2);
  });

  it('the repositories outside the scope are listed with each listing, not between', async () => {
    const { source, count, pass } = setup();
    await source.discover({ due: true });
    pass(5 * MIN);
    await source.discover({ due: true });
    expect(count('listAssignedIssues')).toBe(1);
    pass(10 * MIN);
    await source.discover({ due: true });
    expect(count('listAssignedIssues')).toBe(2);
  });

  it('app mode: the installed repositories are asked with each listing, not between; a sync a person asked for asks at once', async () => {
    const gh = createFakeGitHub({ app: { botLogin: 'hopper-owner[bot]', installedRepos: [REPO, OTHER] } });
    let now = Date.parse('2026-10-13T10:00:00.000Z');
    const source = createGitHubSource({
      name: 'github-app', kind: 'github-app', mode: 'app', assignee: () => 'owner', api: gh, trust: testTrust(),
      config: githubConfig({ repos: [] }), clock: { now: () => new Date(now) }, listingEveryMs: () => 15 * MIN,
    });
    const count = () => gh.calls.filter((c) => c.method === 'listInstalledRepos').length;
    await source.discover({ due: true });
    now += 5 * MIN;
    await source.discover({ due: true });
    expect(count()).toBe(1);
    await source.discover();
    expect(count()).toBe(2);
    now += 15 * MIN;
    await source.discover({ due: true });
    expect(count()).toBe(3);
    expect(source.describe().installedRepos).toEqual([REPO, OTHER]);
  });
});
