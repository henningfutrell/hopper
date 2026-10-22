// A failed item whose report waits (issue #1892 part 32, milestone 4): its job failed, and its final report is not out yet
// (it waits on the job's assessment, or is on its way). The report puts `hopper:failed` on, or leaves the issue as it is for
// a failure the hopper fixes itself; while the job worked, the mirror kept every end label off. So `hopper:failed` is the one
// end label the issue may carry: the mirror takes any other off, puts none on, and Intake gives the item the failed reason.
import { describe, expect, it } from 'vitest';
import { FAILED } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const failed: Partial<WorkItem> = { state: 'failed', eventState: 'failed', jobId: 'job-1', failedJobId: 'job-1' };

describe('a failed item whose report waits: judged by the ledger (issue #1892 part 32)', () => {
  it('Intake gives the failed reason, and the mirror takes a stale end label off', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: failed }, { waits: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(edits()).toEqual([]);
  });

  it('hopper:failed its report put on is kept, and none is put on before the report', async () => {
    const { gh, source, reason } = setup({ [url(1)]: failed, [url(2)]: failed }, { waits: [url(1), url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    expect(reason(2)?.reason).toBe(FAILED);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper']);
  });

  it('hopper:failed taken off by hand before the report is no Run again', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: failed }, { waits: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:failed');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([]);
  });
});
