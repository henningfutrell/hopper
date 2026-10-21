// A dropped item's label mirrors the ledger (issue #1892, milestone 2). An item a person dropped by Won't do (a blocked
// item in Intake, or a hand-off in Needs a person) carries `hopper:rejected`: the act put it on through the outbox. The
// ledger says so, not the labels: the mirror corrects a stale end label, Intake says rejected, and `hopper:rejected` taken
// off by hand is a Run again. An item dropped any other way (cancelled, declined, dismissed) is not judged: the labels decide.
import { describe, expect, it } from 'vitest';
import { FAILED, REJECTED_LABEL } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const dropped = (n: number, wontDo?: true): Partial<WorkItem> => ({ state: 'dropped', eventState: 'dropped', jobId: `job-${n}`, ...(wontDo ? { wontDo } : {}) });

describe('a dropped item: hopper:rejected after a Won\'t do (issue #1892)', () => {
  it('dropped by Won\'t do: Intake says rejected, and the mirror swaps a stale end label for hopper:rejected', async () => {
    const { gh, source, reason } = setup({ [url(1)]: dropped(1, true) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(REJECTED_LABEL);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:rejected']);
  });

  it('hopper:rejected taken off by hand is one Run again, and the label is not put back', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: dropped(1, true) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:rejected'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:rejected');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'dropped', label: 'hopper:rejected', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(REJECTED_LABEL);
    later(60_000);
    await source.discover();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(edits()).toHaveLength(1);
  });

  it('dropped another way: not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: dropped(1) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(FAILED);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:failed']);
    expect(edits()).toEqual([]);
  });
});
