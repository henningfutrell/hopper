// A person's Close PR (issue #1892 part 21, milestone 2): its item is dropped, and the follow put `hopper:pr-closed` on its
// issue. The ledger says so, not the labels: the mirror puts `hopper:pr-closed` back and takes another end label off, and
// Intake gives the item the pr-closed reason. A person who takes `hopper:pr-closed` off by hand asks for a Run again.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, PR_CLOSED } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const closed: Partial<WorkItem> = { state: 'dropped', eventState: 'dropped', jobId: 'job-1', pullRequestState: 'closed', closedByPerson: true };

describe('an item a person\'s Close PR dropped: hopper:pr-closed (issue #1892 part 21)', () => {
  it('Intake gives the pr-closed reason, and the mirror puts hopper:pr-closed on in place of a stale end label', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: closed });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PR_CLOSED);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-closed']);
    expect(edits()).toEqual([]);
  });

  it('hopper:pr-closed taken off by hand is a Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: closed });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PR_CLOSED);
    gh.removeLabel(REPO, 1, 'hopper:pr-closed');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), from: 'dropped', label: 'hopper:pr-closed', means: 'run_again' })]);
    expect(reason(1)?.reason).not.toBe(PR_CLOSED);
  });

  it('an item the hopper\'s own close dropped is not judged: the labels decide', async () => {
    const { gh, source, reason } = setup({ [url(1)]: { ...closed, closedByPerson: undefined } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
  });
});
