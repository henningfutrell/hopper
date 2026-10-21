// An item that needs a person carries no end label (issue #1892, milestone 2). Its job waits on a question, a proposal, a
// research report or a person to pick up the parked job: the job is still the item's, and no report wrote an end label. The
// ledger says so, not the labels: the label mirror takes an end label left on off. A hand-off is not judged: its job failed,
// and its report may have put `hopper:failed` on; the labels decide, as before.
import { describe, expect, it } from 'vitest';
import { FAILED, PR_READY } from '../../src/sources/github/discover.ts';
import { HANDOFF_WAIT, type WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const waiting = (n: number, waitingOn: string): Partial<WorkItem> => ({ state: 'needs_you', eventState: 'needs_you', jobId: `job-${n}`, waitingOn });

describe('an item that needs a person: no end label (issue #1892)', () => {
  it('its job waits on a question or a proposal: the mirror takes an end label left on off, and none is a label edit', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: waiting(1, 'a question'), [url(2)]: waiting(2, 'a proposal') });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:claimed', 'hopper:pr-ready'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:claimed', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).not.toBe(PR_READY);
    expect(reason(2)?.reason).not.toBe(FAILED);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:claimed']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper', 'hopper:claimed']);
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([]);
  });

  it('a hand-off: not judged, its hopper:failed stays and the labels decide', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: { ...waiting(1, HANDOFF_WAIT), failedJobId: 'job-1' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(edits()).toEqual([]);
  });
});
