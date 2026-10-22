// A done item a job's end made, with no whole merge and not by hand (issue #1892 part 24, milestone 2). When its job's final
// report found the issue closed as complete, the report put `hopper:done` on (`doneReported`): the ledger then says so, not
// the labels. Once the issue is open again (reopened), the mirror swaps a stale end label for `hopper:done`, Intake says done,
// and `hopper:done` taken off by hand is a Run again. Before the report is out, not judged: the labels decide. A report that
// found the issue open is part 28's (github-label-done-open.test.ts).
import { describe, expect, it } from 'vitest';
import { BLOCKED, DONE_OPEN } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const done: Partial<WorkItem> = { state: 'done', eventState: 'done', jobId: 'job-1', issueState: 'open' };

describe('a done item whose report put hopper:done on (issue #1892 part 24)', () => {
  it('Intake says done, and the mirror swaps a stale end label for hopper:done', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: done }, { doneReported: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(edits()).toEqual([]);
  });

  it('hopper:done taken off by hand is one Run again, and the label is not put back', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: done }, { doneReported: [url(1)] });
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

  it('no report out yet: not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: done });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(BLOCKED);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(edits()).toEqual([]);
  });
});
