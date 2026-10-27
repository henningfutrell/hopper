// An issue's place for the issue graph (issue #437): GitHub's GraphQL answer read into what the graph is made of.
import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/index.ts';
import { issuePlaceFrom } from '../../src/sources/github/issue-place.ts';
import { issuePlace } from '../../src/sources/github/http/graphql.ts';

const item = (url: string, number: number, state: string, repo = 'Acme/app') => ({ url, number, state, repository: { nameWithOwner: repo } });

describe('issuePlaceFrom', () => {
  it('reads the owner, Projects, closing pull requests, cross-references, parent and sub-issues', () => {
    const place = issuePlaceFrom({ data: { repository: {
      owner: { __typename: 'Organization', login: 'Acme' },
      issue: {
        url: 'https://github.com/Acme/app/issues/7', number: 7, title: 'Add a graph', state: 'OPEN', updatedAt: '2026-10-11T10:00:00Z',
        parent: item('https://github.com/Acme/app/issues/1', 1, 'OPEN'),
        subIssues: { nodes: [item('https://github.com/Acme/app/issues/9', 9, 'CLOSED'), null] },
        blockedBy: { nodes: [item('https://github.com/Acme/app/issues/3', 3, 'OPEN')] },
        projectItems: { nodes: [{ project: { number: 3, title: 'Roadmap', url: 'https://github.com/orgs/Acme/projects/3', owner: { __typename: 'Organization', login: 'Acme' } } }] },
        closedByPullRequestsReferences: { nodes: [item('https://github.com/Acme/app/pull/8', 8, 'MERGED')] },
        timelineItems: { nodes: [
          { source: { __typename: 'Issue', ...item('https://github.com/other/lib/issues/2', 2, 'OPEN', 'other/lib') } },
          { source: { __typename: 'PullRequest', ...item('https://github.com/Acme/app/pull/8', 8, 'MERGED') } },
          {},
        ] },
      },
    } } }, 'place');
    expect(place).toEqual({
      issue: { repo: 'Acme/app', number: 7, url: 'https://github.com/Acme/app/issues/7', title: 'Add a graph', state: 'open', updatedAt: '2026-10-11T10:00:00Z' },
      owner: { login: 'Acme', type: 'Organization' },
      projects: [{ owner: 'Acme', number: 3, url: 'https://github.com/orgs/Acme/projects/3', title: 'Roadmap' }],
      closedBy: [{ kind: 'pull_request', repo: 'Acme/app', number: 8, url: 'https://github.com/Acme/app/pull/8', state: 'merged' }],
      references: [
        { kind: 'issue', repo: 'other/lib', number: 2, url: 'https://github.com/other/lib/issues/2', state: 'open' },
        { kind: 'pull_request', repo: 'Acme/app', number: 8, url: 'https://github.com/Acme/app/pull/8', state: 'merged' },
      ],
      parent: { kind: 'issue', repo: 'Acme/app', number: 1, url: 'https://github.com/Acme/app/issues/1', state: 'open' },
      subIssues: [{ kind: 'issue', repo: 'Acme/app', number: 9, url: 'https://github.com/Acme/app/issues/9', state: 'closed' }],
      blockedBy: [{ kind: 'issue', repo: 'Acme/app', number: 3, url: 'https://github.com/Acme/app/issues/3', state: 'open' }],
    });
  });

  it('asks again without blocked-by when the GitHub it asks has no issue dependencies (an older GitHub Enterprise)', async () => {
    const asked: string[] = [];
    const answer = { data: { repository: { owner: { __typename: 'User', login: 'me' }, issue: { url: 'https://github.com/me/r/issues/1', number: 1, title: 't', state: 'OPEN', updatedAt: 'u' } } } };
    const place = await issuePlace(async (_t, query) => {
      asked.push(query);
      return query.includes('blockedBy') ? { errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'", extensions: { code: 'undefinedField', fieldName: 'blockedBy' } }] } : answer;
    }, 'token', 'me/r', 1);
    expect(asked).toHaveLength(2);
    expect(place).toMatchObject({ issue: { number: 1 }, subIssues: [] });
    expect(place.blockedBy).toBeUndefined();
  });

  it('keeps what a token can read when a part is refused (a user\'s Project and an installation token)', () => {
    const place = issuePlaceFrom({
      data: { repository: { owner: { __typename: 'User', login: 'me' }, issue: { url: 'https://github.com/me/r/issues/1', number: 1, title: 't', state: 'OPEN', updatedAt: 'u', projectItems: { nodes: [{ project: null }] } } } },
      errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
    }, 'place');
    expect(place).toMatchObject({ owner: { login: 'me', type: 'User' }, projects: [], closedBy: [], references: [], subIssues: [] });
  });

  it('reads why a closed issue and its closed sub-issues closed (issue #1036): completed or not planned', () => {
    const place = issuePlaceFrom({ data: { repository: { owner: { __typename: 'User', login: 'me' }, issue: {
      url: 'https://github.com/me/r/issues/1', number: 1, title: 't', state: 'CLOSED', stateReason: 'COMPLETED', updatedAt: 'u',
      subIssues: { nodes: [{ ...item('https://github.com/me/r/issues/2', 2, 'CLOSED', 'me/r'), stateReason: 'NOT_PLANNED' }] },
    } } } }, 'place');
    expect(place.issue).toMatchObject({ state: 'closed', stateReason: 'completed' });
    expect(place.subIssues).toEqual([{ kind: 'issue', repo: 'me/r', number: 2, url: 'https://github.com/me/r/issues/2', state: 'closed', stateReason: 'not_planned' }]);
  });

  it('keeps nothing of the body (issue #2861): a plan artifact is a record of the plan store, never a line of an issue', () => {
    const place = issuePlaceFrom({ data: { repository: { owner: { __typename: 'User', login: 'me' }, issue: {
      url: 'https://github.com/me/r/issues/1', number: 1, title: 't', state: 'OPEN', updatedAt: 'u', body: 'Goal.\n\nArtifact: a screenshot of the board',
    } } } }, 'place');
    expect(place.issue).toEqual({ repo: 'me/r', number: 1, url: 'https://github.com/me/r/issues/1', title: 't', state: 'open', updatedAt: 'u' });
  });

  it('no issue is an error that names the read', () => {
    expect(() => issuePlaceFrom({ data: { repository: { owner: { login: 'me' }, issue: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an Issue.' }] }, 'place of me/r#4'))
      .toThrow(new GitHubApiError('place of me/r#4: Could not resolve to an Issue.', true));
  });
});
