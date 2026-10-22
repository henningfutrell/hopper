// A failed item the hopper fixes itself (issue #1892 part 31, milestone 4; issue #1230, Own PR checks red): its job's failure
// was told as one the hopper fixes, so its report left the issue with no end label. The ledger says so, not the labels: the
// mirror takes a stale end label off, and Intake gives the item no end-label reason. Before the report, the labels decide.
import { describe, expect, it } from 'vitest';
import { FAILED, PR_READY } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const fixing: Partial<WorkItem> = { state: 'failed', eventState: 'failed', jobId: 'job-1', failedJobId: 'job-1' };

describe('a failed item the hopper fixes itself: no end label (issue #1892 part 31)', () => {
  it('told as fixing: Intake gives no end-label reason, and the mirror takes a stale end label off', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: fixing }, { fixing: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).not.toBe(PR_READY);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(edits()).toEqual([]);
  });

  it('hopper:failed put on by hand is no person event: the mirror takes it off', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: fixing }, { fixing: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    gh.addLabel(REPO, 1, 'hopper:failed');
    later(60_000);
    await source.discover();
    expect(reason(1)?.reason).not.toBe(FAILED);
    expect(edits()).toEqual([]);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('its report not out yet: not judged, the labels decide', async () => {
    const { gh, source, reason } = setup({ [url(1)]: fixing });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PR_READY);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
  });
});
