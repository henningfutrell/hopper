// A failed job's locked entry dismissed (issue #1892 part 20, milestone 2): its item is dropped, and its issue keeps
// `hopper:failed`. Once the job's failure was reported as failed (`failureReported`), the ledger says so, not the labels:
// the mirror puts `hopper:failed` back and takes another end label off, and Intake gives the item the failed reason. A
// person who takes `hopper:failed` off by hand asks for a Run again. Before the report, the labels decide.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, FAILED } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const dismissed: Partial<WorkItem> = { state: 'dropped', eventState: 'dropped', jobId: 'job-1', dismissed: true };

describe('a dismissed failure\'s item: hopper:failed (issue #1892 part 20)', () => {
  it('reported: Intake gives the failed reason, and the mirror puts hopper:failed on in place of a stale end label', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: dismissed }, { reported: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(edits()).toEqual([]);
  });

  it('hopper:failed taken off by hand is a Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: dismissed }, { reported: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    gh.removeLabel(REPO, 1, 'hopper:failed');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'dropped', label: 'hopper:failed', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(FAILED);
  });

  it('its failure not reported as failed: not judged, the labels decide', async () => {
    const { gh, source, reason } = setup({ [url(1)]: dismissed });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
  });
});
