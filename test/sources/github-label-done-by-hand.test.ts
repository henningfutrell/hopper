// A done item's label mirrors the ledger when a person did it by hand (issue #1892, milestone 2). A hand-off resolved as
// Done by hand carries `hopper:done`: the resolution put it on through the outbox. The ledger says so, not the labels: the
// mirror corrects a stale end label, Intake says done, and `hopper:done` taken off by hand is a Run again. A done item a
// job's end made, with no whole merge, is not judged: the labels decide.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, FAILED } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const done = (n: number, doneByHand?: true): Partial<WorkItem> => ({ state: 'done', eventState: 'done', jobId: `job-${n}`, ...(doneByHand ? { doneByHand } : {}) });

describe('a done item: hopper:done after a Done by hand (issue #1892)', () => {
  it('done by hand: Intake says done, and the mirror swaps a stale end label for hopper:done', async () => {
    const { gh, source, reason } = setup({ [url(1)]: done(1, true) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
  });

  it('hopper:done taken off by hand is one Run again, and the label is not put back', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: done(1, true) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:done');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'done', label: 'hopper:done', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(DONE_OPEN);
    later(60_000);
    await source.discover();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(edits()).toHaveLength(1);
  });

  it('done by a job\'s end: not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: done(1) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(edits()).toEqual([]);
  });
});
