// A reverted culprit (issue #1892 part 33, milestone 4): its pull request merged into the landing branch as the whole item,
// and a red batch found it the culprit and reverted it (issue #1175). Its item is failed by its landing, not by its job: its
// events say done. The follow put `hopper:done` on at the merge, and nothing took it off: the red batch writes no label to the
// culprit's issue, and no batch run closed it. So the ledger says what the issue carries: the mirror puts back a lost
// `hopper:done` and takes a stale end label off, Intake gives the done-but-open reason (the next sync offers it as a reopened
// card, as before), and `hopper:done` taken off by hand is a Run again. A culprit that was a part stays to the labels.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, PARTLY_DONE } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const pr = `https://github.com/${REPO}/pull/9`;
const culprit: Partial<WorkItem> = {
  state: 'failed', eventState: 'done', jobId: 'job-1', pullRequest: pr, pullRequestState: 'merged', wholeMerged: true, issueState: 'open',
  landing: { repo: REPO.toLowerCase(), pullRequest: 9, stage: 'reverted', since: '2026-10-18T11:00:00.000Z', revert: 10 },
};

describe('a reverted culprit: judged by the ledger (issue #1892 part 33)', () => {
  it('Intake says done but open, and the mirror swaps a stale end label for hopper:done', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: culprit });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(edits()).toEqual([]);
  });

  it('a lost hopper:done goes back on, and one on stays', async () => {
    const { gh, source, reason } = setup({ [url(1)]: culprit, [url(2)]: culprit });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(reason(2)?.reason).toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper', 'hopper:done']);
  });

  it('hopper:done taken off by hand is one Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: culprit });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:done');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'failed', label: 'hopper:done', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(DONE_OPEN);
  });

  it('a culprit that was a part stays to the labels', async () => {
    const { gh, source, reason } = setup({ [url(1)]: { ...culprit, eventState: 'partly_done', wholeMerged: undefined } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:partly-done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PARTLY_DONE);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
  });
});
