// Issue #945, part 4: what each change marks for the index, and where each hit links. An intake event marks the issue it
// names; a read of the issue graph marks every issue and pull request it gave; an issue or a pull request links to its
// job's view, else to itself on GitHub.
import { describe, expect, it } from 'vitest';
import { graphKeys, keysOf } from '../../src/search/index.ts';
import { searchHitRoute } from '../../src/domain/search.ts';
import { placeGraph } from '../../src/domain/issue-graph.ts';
import type { UserStore } from '../../src/domain/store.ts';
import { storeSourceContext } from '../../src/users/source-context.ts';

const ISSUE = 'https://github.com/o/r/issues/7';

describe('the pending keys of a change (issue #945, part 4)', () => {
  it('marks the issue an intake event names, and each issue a person assigned', () => {
    expect(keysOf({ type: 'source.request_opened', data: { source: 'gh', key: ISSUE } })).toEqual([`issue:${ISSUE}`]);
    expect(keysOf({ type: 'source.issues_assigned', data: { source: 'gh', keys: [ISSUE, 'https://github.com/o/r/issues/8'], assignee: 'a' } }))
      .toEqual([`issue:${ISSUE}`, 'issue:https://github.com/o/r/issues/8']);
    expect(keysOf({ type: 'item.snapshot_recorded', jobId: 'j1', data: { key: ISSUE } })).toEqual(['job:j1', `issue:${ISSUE}`]);
    expect(keysOf({ type: 'source.request_opened', data: { source: 'manual', key: 'manual:1' } })).toEqual([]);
  });

  it('marks every issue and pull request one read of the issue graph gave', () => {
    const g = placeGraph({
      issue: { repo: 'o/r', number: 7, url: ISSUE, title: 't', state: 'OPEN', updatedAt: 'x' }, owner: { login: 'o' }, projects: [],
      closedBy: [{ kind: 'pull_request', repo: 'o/r', number: 9, url: 'https://github.com/o/r/pull/9' }], references: [], subIssues: [],
    });
    expect(graphKeys(g).sort()).toEqual([`issue:${ISSUE}`, 'pull-request:https://github.com/o/r/pull/9']);
  });
});

describe('where a hit links (issue #945, part 4)', () => {
  it('links an issue or a pull request to its job\'s view, else to the item itself', () => {
    expect(searchHitRoute('issue', ISSUE, 'j7')).toBe('job/j7');
    expect(searchHitRoute('pull-request', 'https://github.com/o/r/pull/9')).toBeUndefined();
    expect(searchHitRoute('job', 'j1')).toBe('job/j1');
  });
});

describe('a read of the issue graph marks what it gave (issue #945, part 4)', () => {
  it('names the issues and pull requests to search after the store kept the read', () => {
    const kept: string[] = [], named: string[][] = [];
    const store = { issueGraph: { record: (issue: string) => { kept.push(issue); }, lastRead: () => undefined } } as unknown as UserStore;
    const ctx = storeSourceContext(store, undefined, undefined, undefined, (keys) => { named.push(keys); });
    const g = placeGraph({ issue: { repo: 'o/r', number: 7, url: ISSUE, title: 't', state: 'OPEN', updatedAt: 'x' }, owner: { login: 'o' }, projects: [], closedBy: [], references: [], subIssues: [] });
    ctx.issueGraph.record(ISSUE, g, 'x');
    expect(kept).toEqual([ISSUE]);
    expect(named).toEqual([[`issue:${ISSUE}`]]);
  });
});
