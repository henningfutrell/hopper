// An item that needs a person carries no end label (issue #1892, milestone 2). Its job waits on a question, a proposal, a
// research report or a person to pick up the parked job: the job is still the item's, and no report wrote an end label. The
// ledger says so, not the labels: the label mirror takes an end label left on off. A hand-off's job failed: once its
// failure was reported as failed, `hopper:failed` is its label, as a failed item's (part 3); before, the labels decide.
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

  it('a hand-off whose failure was reported: hopper:failed is its label, Intake says failed, and taking it off is a Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: { ...waiting(1, HANDOFF_WAIT), failedJobId: 'job-1' }, [url(2)]: { ...waiting(2, HANDOFF_WAIT), failedJobId: 'job-2' } }, { reported: [url(1), url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    gh.removeLabel(REPO, 2, 'hopper:failed');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(2), from: 'needs_you', label: 'hopper:failed', means: 'run_again' })]);
  });

  it('a hand-off whose failure was not reported: not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: { ...waiting(1, HANDOFF_WAIT), failedJobId: 'job-1' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(edits()).toEqual([]);
  });
});
