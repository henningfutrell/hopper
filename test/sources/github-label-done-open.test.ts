// A done item a job's end made while its issue was open (issue #1892 part 28, milestone 2). The job's final report set the
// labels by what the issue said then (`doneReported`): its pull request waits (`hopper:pr-ready`, a part's
// `hopper:partly-done`), or none is open (no end label, issue #2693), and the report follows the issue. The ledger then says
// so, not the labels: the mirror puts back a label that is lost or wrong, Intake gives the report's reason, and the label
// taken off by hand is a Run again.
import { describe, expect, it } from 'vitest';
import { DONE_OPEN, PARTLY_DONE, PR_READY } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const done: Partial<WorkItem> = { state: 'done', eventState: 'done', jobId: 'job-1', issueState: 'open' };

describe('a done item whose report found its issue open (issue #1892 part 28)', () => {
  it('no pull request open (issue #2693): Intake says done but open, and the mirror takes a stale end label off and puts none on', async () => {
    const { gh, source, reason, edits } = setup({ [url(1)]: done }, { doneOpen: { [url(1)]: 'no_pr' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:failed'] });
    await source.discover();
    expect(reason(1)).toMatchObject({ reason: DONE_OPEN });
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(edits()).toEqual([]);
  });

  it('its pull request waits: Intake says so, and a lost hopper:pr-ready goes back on', async () => {
    const { gh, source, reason } = setup({ [url(1)]: done }, { doneOpen: { [url(1)]: 'pr_open' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper'] });
    await source.discover();
    expect(reason(1)).toMatchObject({ reason: PR_READY, group: 'pr-waiting' });
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('its part waits: Intake says partly done, and hopper:pr-ready stays', async () => {
    const { gh, source, reason } = setup({ [url(1)]: done }, { doneOpen: { [url(1)]: 'part' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await source.discover();
    expect(reason(1)?.reason).toBe(PARTLY_DONE);
    expect(await source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('a hopper:blocked an earlier rule put on comes off (issue #2693), and its going is no Run again', async () => {
    const { gh, source, reason, edits, later } = setup({ [url(1)]: done }, { doneOpen: { [url(1)]: 'no_pr' } });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:blocked'] });
    await source.discover();
    await source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    later(60_000);
    await source.discover();
    expect(edits()).toEqual([]);
    expect(reason(1)?.reason).toBe(DONE_OPEN);
  });
});
