// Git answers (issue #858 part 2): the port's reads of pull requests say whether one has conflicts as the hopper's mirror
// says (`git merge-tree`), not as GitHub's `mergeable` does; GitHub's answer stays where git cannot say. Through the
// real pass reads, over a stub of the adapter whose pull requests GitHub has not computed (`conflicting: false`), and a
// real mirror of a real origin.
//
// Feature: conflicts from git
//   Scenario: a sync pass reads the pull requests of an issue, one by its number, and the repository's open ones
//     Then each open one's conflicts are git's, and the repository is fetched once in the pass
//   Scenario: a read outside a pass, a closed pull request, an adapter with no git
//     Then GitHub's answer stays
//   Scenario: whether two pull requests conflict with each other (issue #939)
//     Then git says, in a pass; with an adapter with no git, the port has no such answer
//   Scenario: one pull request read by its number (issue #935 part 2)
//     Then it carries its commits and the files it changes, as the mirror says; the list reads do not
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { createGitMirrors } from '../../src/git-mirror/mirrors.ts';
import type { BranchPullRequest, GitHubApi, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from '../../src/sources/github/api.ts';
import { gitAnswers } from '../../src/sources/github/git-answers.ts';
import { passReads } from '../../src/sources/github/pass-reads.ts';
import { origin } from '../git-mirror/support.ts';

const URL_OF = (n: number): string => `https://github.com/acme/app/pull/${n}`;

function stub(heads: Record<number, string>, url: string, o: { git?: boolean } = {}): GitHubApi {
  const open = (n: number): OpenPullRequest => ({ url: URL_OF(n), createdAt: '2026-10-12T00:00:00Z', isDraft: false, conflicting: false, headOid: heads[n]!, base: 'dev' });
  const api: Partial<GitHubApi> = {
    openClosingPullRequests: async () => [open(1), open(2)],
    referencingPullRequests: async () => [
      { ...open(2), state: 'open', body: 'Part of #5', repo: 'acme/app' },
      { ...open(2), url: URL_OF(3), state: 'closed', body: '', repo: 'acme/app' },
    ] satisfies ReferencingPullRequest[],
    pullRequest: async (_repo, n) => ({ ...open(n), state: 'open' }) satisfies NumberedPullRequest,
    openPullRequests: async () => [{ ...open(2), headRef: 'issue-5', body: '' }] satisfies BranchPullRequest[],
    ...(o.git === false ? {} : { gitRemote: async () => ({ url }) }),
  };
  return api as GitHubApi;
}

describe('git answers (issue #858 part 2)', () => {
  it("gives each open pull request git's conflicts, the repository fetched once in the pass", async () => {
    const o = origin();
    const lines: string[] = [];
    const traffic = createGitHubTraffic({ log: (l) => lines.push(l) });
    const mirrors = createGitMirrors({ dir: join(o.root, 'mirrors'), traffic, log: (l) => lines.push(l) });
    const reads = passReads(gitAnswers(stub(o.heads, o.url), mirrors), 'github', traffic);
    const [closing, referencing, numbered, repoOpen] = await reads.pass(async () => Promise.all([
      reads.api.openClosingPullRequests('acme/app', 5),
      reads.api.referencingPullRequests('acme/app', 5),
      reads.api.pullRequest('acme/app', 2),
      reads.api.openPullRequests('acme/app'),
    ]));
    expect(closing.map((p) => p.conflicting)).toEqual([false, true]);
    expect(referencing.map((p) => [p.url, p.conflicting])).toEqual([[URL_OF(2), true], [URL_OF(3), false]]);
    expect(numbered?.conflicting).toBe(true);
    expect(repoOpen.map((p) => p.conflicting)).toEqual([true]);
    expect(lines).toContain('hopper: GitHub traffic of sync pass github: REST 0, GraphQL 0, git fetches 1 (acme/app 1; by hopper 1)');
  });

  it("keeps GitHub's answer outside a pass and with an adapter that says nowhere git fetches", async () => {
    const o = origin();
    const traffic = createGitHubTraffic({ log: () => undefined });
    const mirrors = createGitMirrors({ dir: join(o.root, 'mirrors'), traffic, log: () => undefined });
    const outside = passReads(gitAnswers(stub(o.heads, o.url), mirrors), 'github', traffic);
    expect((await outside.api.pullRequest('acme/app', 2))?.conflicting).toBe(false);
    const noGit = passReads(gitAnswers(stub(o.heads, o.url, { git: false }), mirrors), 'github', traffic);
    expect((await noGit.pass(() => noGit.api.pullRequest('acme/app', 2)))?.conflicting).toBe(false);
  });

  it('says whether two pull requests conflict with each other, in a pass (issue #939)', async () => {
    const o = origin();
    const traffic = createGitHubTraffic({ log: () => undefined });
    const mirrors = createGitMirrors({ dir: join(o.root, 'mirrors'), traffic, log: () => undefined });
    const reads = passReads(gitAnswers(stub(o.heads, o.url), mirrors), 'github', traffic);
    const said = await reads.pass(async () => [
      await reads.api.conflictBetween!('acme/app', 'dev', 1, 3),
      await reads.api.conflictBetween!('acme/app', 'dev', 1, 4),
    ]);
    expect(said).toEqual([true, false]);
    expect(passReads(gitAnswers(stub(o.heads, o.url, { git: false }), mirrors), 'github', traffic).api.conflictBetween).toBeUndefined();
  });

  it('gives a pull request read by its number its commits and files, from the mirror; the lists carry none (issue #935 part 2)', async () => {
    const o = origin();
    const traffic = createGitHubTraffic({ log: () => undefined });
    const mirrors = createGitMirrors({ dir: join(o.root, 'mirrors'), traffic, log: () => undefined });
    const reads = passReads(gitAnswers(stub(o.heads, o.url), mirrors), 'github', traffic);
    const [numbered, listed] = await reads.pass(async () => [await reads.api.pullRequest('acme/app', 1), await reads.api.openPullRequests('acme/app')] as const);
    expect(numbered).toMatchObject({ commits: [`${o.heads[1]!.slice(0, 7)} pr one`], files: ['b.txt'] });
    expect(listed[0]).not.toHaveProperty('files');
    const outside = passReads(gitAnswers(stub(o.heads, o.url), mirrors), 'github', traffic);
    expect(await outside.api.pullRequest('acme/app', 1)).not.toHaveProperty('files');
  });
});
