// A partly done item's labels mirror the ledger (issue #1892, milestone 2). Its pull request merged as a part, and parts are
// left: the follow took `hopper:partly-done` off, so Intake takes the issue again and the next part runs. The ledger says so,
// not the labels: a stale end label gives no reason, and the label mirror takes it off. A last part that made every declared
// part done put `hopper:done` on (part 35): the ledger says done but open. A merge the follow did not record is not judged.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, PARTLY_DONE } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const merged = (n: number): Partial<WorkItem> => ({
  state: 'partly_done', eventState: 'partly_done', jobId: `job-${n}`, pullRequest: `https://github.com/${REPO}/pull/${n + 10}`, pullRequestState: 'merged',
});

describe('a partly done item: no end label once its merged part leaves parts to run (issue #1892)', () => {
  it('a stale hopper:partly-done gives no reason: Intake takes the issue again, and the next part runs', async () => {
    const { gh, source, reason } = setup({ [url(1)]: merged(1) }, { partsLeft: [url(1)], rerunnable: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:partly-done'] });
    expect((await source.discover()).map((i) => i.key)).toEqual([url(1)]);
    expect(reason(1)?.reason).toBeUndefined();
  });

  it('not taken yet (its job\'s report waits): the mirror takes any end label off, and none is a label edit', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: merged(1), [url(2)]: merged(2) }, { partsLeft: [url(1), url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:partly-done'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).not.toBe(PARTLY_DONE);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper']);
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([]);
  });

  it('a last part that made every part done (part 35): Intake says done but open, and the mirror swaps a stale end label for hopper:done', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: merged(1), [url(2)]: merged(2) }, { lastPart: [url(1), url(2)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:partly-done'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(reason(2)?.reason).toBe(DONE_OPEN);
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:done']);
    expect(gh.issue(REPO, 2).labels).toEqual(['hopper', 'hopper:done']);
    expect(edits()).toEqual([]);
  });

  it('a last part: hopper:done taken off by hand is a Run again', async () => {
    const { gh, source, edits, later } = setup({ [url(1)]: merged(1) }, { lastPart: [url(1)] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    await source.discover();
    gh.removeLabel(REPO, 1, 'hopper:done');
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([expect.objectContaining({ key: url(1), label: 'hopper:done', means: 'run_again' })]);
  });

  it('a merge the follow did not record: not judged, the labels decide', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: merged(1), [url(2)]: merged(2) });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:done'] });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:partly-done'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(DONE_OPEN);
    expect(reason(2)?.reason).toBe(PARTLY_DONE);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(edits()).toEqual([]);
  });
});
