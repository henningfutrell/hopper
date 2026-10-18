// Issue #655 part 19: the GraphQL answers of an item an issue's text names, and of an issue's edits (issue #662), as the
// batched read hands them over — the whole body, `{ data, errors }`.
import { describe, expect, it } from 'vitest';
import { issueEditsFrom, linkedItemFrom } from '../../src/sources/github/http/graphql.ts';

describe('linkedItemFrom (issue #655, part 19)', () => {
  it('a pull request of a fork, in a public repository', () => {
    const body = { data: { repository: { visibility: 'PUBLIC', issueOrPullRequest: { url: 'https://github.com/o/r/pull/3', isCrossRepository: true, author: { login: 'stranger' } } } } };
    expect(linkedItemFrom(body)).toEqual({ visibility: 'public', pullRequest: { url: 'https://github.com/o/r/pull/3', author: 'stranger', fork: true } });
  });

  it('an issue, and a pull request whose author GitHub no longer names', () => {
    expect(linkedItemFrom({ data: { repository: { visibility: 'PRIVATE', issueOrPullRequest: {} } } })).toEqual({ visibility: 'private' });
    expect(linkedItemFrom({ data: { repository: { visibility: 'INTERNAL', issueOrPullRequest: { url: 'u', isCrossRepository: false, author: null } } } }))
      .toEqual({ visibility: 'internal', pullRequest: { url: 'u', fork: false } });
  });

  it('a name GitHub does not show is nothing; any other error throws', () => {
    expect(linkedItemFrom({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'no repo' }] })).toEqual({});
    expect(() => linkedItemFrom({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] })).toThrow(/slow down/);
  });
});

describe('issueEditsFrom (issue #662)', () => {
  it('reads the edits under data, oldest first', () => {
    const body = { data: { repository: { issue: {
      userContentEdits: { nodes: [{ editedAt: '2026-10-02T10:00:00Z', editor: { login: 'stranger' } }, { editedAt: '2026-10-02T08:00:00Z', editor: null }] },
      timelineItems: { nodes: [{ createdAt: '2026-10-02T09:00:00Z', actor: { login: 'owner' } }] },
    } } } };
    expect(issueEditsFrom(body)).toEqual([
      { what: 'body', editor: 'ghost', at: '2026-10-02T08:00:00Z' },
      { what: 'title', editor: 'owner', at: '2026-10-02T09:00:00Z' },
      { what: 'body', editor: 'stranger', at: '2026-10-02T10:00:00Z' },
    ]);
  });

  it('an error throws, so the edits count as not known', () => {
    expect(() => issueEditsFrom({ data: null, errors: [{ type: 'FORBIDDEN', message: 'no access' }] })).toThrow(/no access/);
  });
});
