// Cross-reference detection (issue #430) in the GitHub source: the links of a job's issue — the pull requests and commits,
// of its repository or another, whose text closes it with a closing keyword, confirmed by what GitHub links as closing it
// (`closedByPullRequestsReferences`, a commit's close). A text reference GitHub does not treat as closing is not linked. And
// the GraphQL answer as the port reads it.
import { describe, expect, it } from 'vitest';
import { CLOSING_KEYWORDS } from '../../src/domain/cross-references.ts';
import { crossReferencesFrom } from '../../src/sources/github/closer.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AT = '2026-10-02T11:00:00.000Z';
const OTHER = 'other/lib';

function withIssue() {
  const s = setup();
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  return s;
}

describe('the links of a job\'s issue', () => {
  it.each(CLOSING_KEYWORDS.map((k) => [k]))('a pull request of its repository saying "%s #1": linked, with the keyword', async (keyword) => {
    const { gh, source } = withIssue();
    const url = gh.mentionIssue(REPO, 1, { text: `${keyword} #1`, closes: true, createdAt: AT });
    expect(await source.crossReferences!(jobForIssue(1))).toEqual([{ kind: 'pull_request', repo: REPO, url, keyword }]);
  });

  it('pull requests of another repository, by owner/repo#N and by the issue URL: linked', async () => {
    const { gh, source } = withIssue();
    const byName = gh.mentionIssue(REPO, 1, { from: OTHER, text: `Fixes ${REPO}#1`, closes: true, createdAt: AT });
    const byUrl = gh.mentionIssue(REPO, 1, { from: OTHER, text: `Resolves https://github.com/${REPO}/issues/1`, closes: true, createdAt: AT });
    expect(byName).toMatch(/^https:\/\/github\.com\/other\/lib\/pull\//);
    expect(await source.crossReferences!(jobForIssue(1))).toEqual([
      { kind: 'pull_request', repo: OTHER, url: byName, keyword: 'fixes' },
      { kind: 'pull_request', repo: OTHER, url: byUrl, keyword: 'resolves' },
    ]);
  });

  it('a text reference GitHub does not treat as closing is not linked: a mention, a part, a closing text GitHub does not confirm', async () => {
    const { gh, source } = withIssue();
    gh.mentionIssue(REPO, 1, { text: 'Refs #1', closes: false, createdAt: AT });
    gh.openPartPullRequest(REPO, 1, { createdAt: AT });
    // A pull request to a branch that is not the default one: its keyword closes nothing on GitHub.
    gh.mentionIssue(REPO, 1, { text: 'Fixes #1', closes: false, createdAt: AT });
    expect(await source.crossReferences!(jobForIssue(1))).toEqual([]);
  });

  it('a commit that closed the issue: linked, with its message\'s keyword', async () => {
    const { gh, source } = withIssue();
    const url = gh.mentionIssue(REPO, 1, { kind: 'commit', text: 'Close #1: done', closes: true, createdAt: AT });
    expect(url).toMatch(/\/commit\/[0-9a-f]+$/);
    expect(gh.issue(REPO, 1).state).toBe('closed');
    expect(await source.crossReferences!(jobForIssue(1))).toEqual([{ kind: 'commit', repo: REPO, url, keyword: 'close' }]);
  });

  it('a job with no GitHub issue has none, and asks nothing', async () => {
    const { gh, source } = withIssue();
    expect(await source.crossReferences!({ ...jobForIssue(1), source: undefined })).toEqual([]);
    expect(gh.calls).toEqual([]);
  });
});

describe('the GraphQL answer', () => {
  it('mentions from cross-references, references and the closing pull requests; closing from those and a commit\'s close', () => {
    const pr = (url: string, body: string, repo = REPO) => ({ __typename: 'PullRequest', url, body, repository: { nameWithOwner: repo } });
    const body = { data: { repository: { issue: {
      closedByPullRequestsReferences: { nodes: [pr('https://github.com/owner/sandbox/pull/5', 'Fixes #1'), null] },
      timelineItems: { nodes: [
        { __typename: 'CrossReferencedEvent', source: pr('https://github.com/other/lib/pull/2', 'See owner/sandbox#1', OTHER) },
        { __typename: 'CrossReferencedEvent', source: { __typename: 'Issue', url: 'https://github.com/owner/sandbox/issues/9' } },
        { __typename: 'ReferencedEvent', commit: { url: 'https://github.com/owner/sandbox/commit/abc', message: 'closes #1' }, commitRepository: { nameWithOwner: REPO } },
        { __typename: 'ClosedEvent', closer: { __typename: 'Commit', url: 'https://github.com/owner/sandbox/commit/abc', message: 'closes #1', repository: { nameWithOwner: REPO } } },
        { __typename: 'ClosedEvent', closer: null },
      ] },
    } } } };
    expect(crossReferencesFrom(body, 'cross-references of owner/sandbox#1')).toEqual({
      mentions: [
        { kind: 'pull_request', repo: REPO, url: 'https://github.com/owner/sandbox/pull/5', text: 'Fixes #1' },
        { kind: 'pull_request', repo: OTHER, url: 'https://github.com/other/lib/pull/2', text: 'See owner/sandbox#1' },
        { kind: 'commit', repo: REPO, url: 'https://github.com/owner/sandbox/commit/abc', text: 'closes #1' },
      ],
      closing: [
        { kind: 'pull_request', repo: REPO, url: 'https://github.com/owner/sandbox/pull/5' },
        { kind: 'commit', repo: REPO, url: 'https://github.com/owner/sandbox/commit/abc' },
      ],
    });
  });

  it('a GraphQL error throws', () => {
    expect(() => crossReferencesFrom({ errors: [{ type: 'NOT_FOUND', message: 'gone' }] }, 'cross-references')).toThrow(/gone/);
  });
});
