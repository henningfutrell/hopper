// A cancelled or rejected job's item carries no end label (issue #1892 part 19, milestone 2). Its report took only the
// claim off, and while its job worked the mirror kept every end label off: the ledger says so, not the labels. Once the
// report went out (`dropReported`), the mirror takes a stale end label off and Intake gives the item no end-label reason.
// An end label a person puts on such an item by hand is a person's event, never read back as state: one
// `work_item.label_edited` with `means: keep_out`; the label stays and decides Intake's reason. Taken off again, it is a Run again.
// A tend job cancelled by no person and no source (part 23): its report put `hopper:pr-ready` back, as its pull request waits
// to be tended again; the item carries that label, and Intake's reason is PR open's.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, PR_READY, REJECTED_LABEL } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const cancelled: Partial<WorkItem> = { state: 'dropped', eventState: 'dropped', jobId: 'job-1' };

describe('a cancelled or rejected job\'s item: no end label (issue #1892 part 19)', () => {
  it('reported: Intake gives no end-label reason, and the mirror takes a stale end label off', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: cancelled }, { dropped: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).not.toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(edits()).toEqual([]);
  });

  it('an end label a person puts on by hand keeps it out, once: the label stays and decides Intake\'s reason', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: cancelled }, { dropped: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    gh.addLabel(REPO, 1, 'hopper:rejected');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'dropped', label: 'hopper:rejected', means: 'keep_out' }]);
    expect(reason(1)?.reason).toBe(REJECTED_LABEL);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    later(60_000);
    await source.discover();
    expect(edits()).toHaveLength(1);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:rejected']);
  });

  it('that label taken off again is a Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: { ...cancelled, keptOut: 'hopper:rejected' } }, { dropped: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:rejected'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(REJECTED_LABEL);
    gh.removeLabel(REPO, 1, 'hopper:rejected');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'dropped', label: 'hopper:rejected', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(REJECTED_LABEL);
  });

  it('its report not out yet: not judged, the labels decide', async () => {
    const { gh, source, reason } = setup({ [url(1)]: cancelled });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
  });

  it('a tend job cancelled not on purpose, reported: hopper:pr-ready, and Intake says its pull request waits', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: cancelled }, { tendAgain: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PR_READY);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
    expect(edits()).toEqual([]);
  });

  it('a tend job\'s hopper:pr-ready taken off by hand is a Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: cancelled }, { tendAgain: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:pr-ready');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'dropped', label: 'hopper:pr-ready', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(PR_READY);
  });
});
