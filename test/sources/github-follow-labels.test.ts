// The follow's labels come from the ledger's state (issue #1892 part 14): how a followed pull request ends for its item
// names the state the item moves to, `labelsFor` that state names the end labels, and the change goes out through the
// GitHub outbox (act `follow`), kept as rows before it is sent, never as a call of the follow's own.
import { describe, expect, it } from 'vitest';
import { followLabels } from '../../src/sources/github/item-labels.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';

describe('followLabels: the end labels of the state a follow moves the item to', () => {
  it('merged as the whole item: hopper:done, every other end label off', () => {
    expect(followLabels({ end: 'merged' }, ['hopper', 'hopper:pr-ready', 'hopper:failed'])).toEqual({ remove: ['hopper:pr-ready', 'hopper:failed'], add: ['hopper:done'] });
    expect(followLabels({ end: 'merged' }, ['hopper', 'hopper:done'])).toBeUndefined();
  });

  it('a part merged with parts left: no end label, so the next part runs', () => {
    expect(followLabels({ end: 'part_merged' }, ['hopper', 'hopper:partly-done'])).toEqual({ remove: ['hopper:partly-done'], add: [] });
    expect(followLabels({ end: 'part_merged' }, ['hopper', 'hopper:done'])).toEqual({ remove: ['hopper:done'], add: [] });
    expect(followLabels({ end: 'part_merged' }, ['hopper'])).toBeUndefined();
  });

  it('closed without a merge: blocked, hopper:pr-closed', () => {
    expect(followLabels({ end: 'closed' }, ['hopper', 'hopper:partly-done'])).toEqual({ remove: ['hopper:partly-done'], add: ['hopper:pr-closed'] });
  });

  it('a blocked item whose pull request is found open: PR open, its waiting label of a whole or of a part', () => {
    expect(followLabels({ end: 'found_open', part: false }, ['hopper', 'hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: ['hopper:pr-ready'] });
    expect(followLabels({ end: 'found_open', part: true }, ['hopper', 'hopper:blocked'])).toEqual({ remove: ['hopper:blocked'], add: ['hopper:partly-done'] });
  });

  it('abandoned (closed as not planned): the waiting labels come off and none goes on; a state the ledger does not judge', () => {
    expect(followLabels({ end: 'abandoned' }, ['hopper', 'hopper:pr-ready', 'hopper:rejected'])).toEqual({ remove: ['hopper:pr-ready'], add: [] });
    expect(followLabels({ end: 'abandoned' }, ['hopper', 'hopper:rejected'])).toBeUndefined();
  });
});

describe('the follow\'s label change goes through the GitHub outbox', () => {
  async function ended() {
    const s = setup();
    s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
    const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AFTER });
    const base = jobForIssue(1, { status: 'finished' });
    const state = await s.source.report({ kind: 'finished', job: base });
    return { ...s, pr, job: { ...base, sourceState: { source: state } } };
  }
  const pending = (source: ReturnType<typeof setup>['source']) => (source.describe() as { writeBehindPending?: number }).writeBehindPending;

  it('merged: the labels change in one remove and one add, sent at once, and nothing is left on the way', async () => {
    const { gh, source, job, pr } = await ended();
    gh.mergePullRequest(pr.url);
    gh.calls.length = 0;
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged' });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(gh.calls.filter((c) => c.method === 'removeLabels' || c.method === 'addLabels').map((c) => c.method)).toEqual(['removeLabels', 'addLabels']);
    expect(pending(source)).toBeUndefined();
  });

  it('GitHub refuses the label change for now: the follow still ends, its rows wait, and the next send makes it once', async () => {
    const { gh, source, job, pr } = await ended();
    gh.mergePullRequest(pr.url);
    gh.failNext('removeLabels', new TypeError('fetch failed'));
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged' });
    expect(gh.issue(REPO, 1).labels).toContain('hopper:pr-ready');
    expect(pending(source)).toBe(2);
    // The same end followed again (a stop before its record): its rows are on their way, so none is kept twice.
    await source.follow!(job);
    expect(pending(source)).toBe(2);
  });
});
