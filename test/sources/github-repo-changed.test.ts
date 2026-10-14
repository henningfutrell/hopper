// Issue #1079: a GitHub delivery says a job repository changed. The source makes that repository's listing due, so the
// next timed sync lists it (and only it) at once, not after the intake sync interval. A repository that is no job
// repository of the source is not its own: nothing is due.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub, createGitHubSource } from '../../src/sources/github/index.ts';
import { REPO, githubConfig, testTrust } from './fixtures/github-support.ts';

const MIN = 60_000;
const OTHER = 'owner/other';

function setup() {
  const gh = createFakeGitHub();
  let now = Date.parse('2026-10-14T01:19:00.000Z');
  const source = createGitHubSource({
    name: 'github', kind: 'github-account', mode: 'account', whoami: 'owner', assignee: () => 'owner', api: gh, trust: testTrust(),
    config: githubConfig({ repos: [REPO, OTHER] }), clock: { now: () => new Date(now) }, listingEveryMs: () => 15 * MIN,
  });
  const listings = () => gh.calls.filter((c) => c.method === 'listRepos').map((c) => c.args[0]);
  return { gh, source, listings, pass: (ms: number) => { now += ms; } };
}

describe('a repository changed on GitHub (issue #1079)', () => {
  it('lists that repository at the next timed sync, inside the interval, and only it', async () => {
    const { gh, source, listings, pass } = setup();
    await source.discover({ due: true });
    gh.createIssue({ repo: REPO, labels: ['hopper'], assignees: ['owner'] });
    pass(MIN);
    expect(source.repoChanged!(REPO)).toBe(true);
    expect((await source.discover({ due: true })).map((i) => i.number)).toEqual([1]);
    expect(listings()).toEqual([[REPO, OTHER], [REPO]]);
    // Listed once: the next timed sync inside the interval lists nothing again.
    pass(MIN);
    await source.discover({ due: true });
    expect(listings()).toHaveLength(2);
  });

  it('a repository that is no job repository of the source is not its own', async () => {
    const { source, listings } = setup();
    await source.discover({ due: true });
    expect(source.repoChanged!('someone/else')).toBe(false);
    await source.discover({ due: true });
    expect(listings()).toHaveLength(1);
  });

  it('names the repository in any case GitHub writes it', async () => {
    const { source, listings } = setup();
    await source.discover({ due: true });
    expect(source.repoChanged!(REPO.toUpperCase())).toBe(true);
    await source.discover({ due: true });
    expect(listings()).toEqual([[REPO, OTHER], [REPO]]);
  });

  it('app mode: an installed repository is the source\'s own', async () => {
    const gh = createFakeGitHub({ app: { botLogin: 'hopper-owner[bot]', installedRepos: [REPO] } });
    const source = createGitHubSource({
      name: 'github-app', kind: 'github-app', mode: 'app', assignee: () => 'owner', api: gh, trust: testTrust(),
      config: githubConfig({ repos: [] }), clock: { now: () => new Date('2026-10-14T01:19:00.000Z') }, listingEveryMs: () => 15 * MIN,
    });
    await source.discover({ due: true });
    expect(source.repoChanged!(REPO)).toBe(true);
    expect(source.repoChanged!(OTHER)).toBe(false);
    await source.discover({ due: true });
    expect(gh.calls.filter((c) => c.method === 'listRepos').map((c) => c.args[0])).toEqual([[REPO], [REPO]]);
  });
});
