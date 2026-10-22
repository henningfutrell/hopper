// A blocked item's pull request found open (issue #1891) is judged by the ledger, not by `hopper:blocked` on its issue
// (issue #1892 part 27, milestone 4): the ledger says the item is blocked for want of a pull request, by this job, with no
// Run again asked. Only an item the ledger does not know, or a state the mirror does not judge, is judged by its labels.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO, jobForIssue } from './fixtures/github-support.ts';
import { labelMirrorSetup, url } from './fixtures/label-mirror-support.ts';

const AFTER = '2026-10-02T11:00:00.000Z';

afterEach(() => { vi.restoreAllMocks(); });

/** A done job of issue #1 that follows no pull request yet, its item as the ledger has it, and a pull request opened since. */
function blockedWith(labels: string[], item?: (jobId: string) => Partial<WorkItem>) {
  const job = jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open' } } });
  const s = labelMirrorSetup(item ? { [url(1)]: item(job.id) } : {});
  s.gh.createIssue({ repo: REPO, labels });
  const pr = s.gh.openPullRequest(REPO, 1, { createdAt: AFTER });
  return { ...s, job, pr };
}
const blocked = (jobId: string): Partial<WorkItem> => ({ state: 'blocked', eventState: 'blocked', blockedCause: 'no_pr', jobId });

describe('a blocked item\'s pull request found open: the ledger decides its labels', () => {
  it('blocked by this job, its label not on the issue: PR open\'s label goes on', async () => {
    const { gh, source, job, pr } = blockedWith(['hopper'], blocked);
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', pullRequest: pr.url });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('blocked by this job, hopper:blocked on: it comes off and PR open\'s label goes on', async () => {
    const { gh, source, job } = blockedWith(['hopper', 'hopper:blocked'], blocked);
    await source.follow!(job);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('a newer job works on the item, a stale hopper:blocked still on: the old job\'s follow writes no label', async () => {
    const { gh, source, job, pr } = blockedWith(['hopper', 'hopper:blocked'], () => ({ state: 'working', eventState: 'working', jobId: 'job-newer' }));
    gh.calls.length = 0;
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', pullRequest: pr.url });
    expect(gh.calls.filter((c) => c.method === 'removeLabels' || c.method === 'addLabels')).toEqual([]);
  });

  it('blocked, and a person asked to run it again: no label', async () => {
    const { gh, source, job } = blockedWith(['hopper'], (id) => ({ ...blocked(id), runAgainAsked: 'hopper:blocked' }));
    await source.follow!(job);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
  });

  it('blocked by another cause (stale): no label from the follow', async () => {
    const { gh, source, job } = blockedWith(['hopper', 'hopper:blocked'], (id) => ({ ...blocked(id), blockedCause: 'stale' }));
    await source.follow!(job);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:blocked']);
  });

  it('done by this job\'s end, its report found no pull request (part 28), its label not on: PR open\'s label goes on', async () => {
    const { gh, source, job } = blockedWith(['hopper'], (id) => ({ state: 'done', eventState: 'done', jobId: id, issueState: 'open' }));
    await source.follow!(job);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });

  it('an item the ledger does not know: its hopper:blocked decides, as before', async () => {
    const { gh, source, job } = blockedWith(['hopper', 'hopper:blocked']);
    await source.follow!(job);
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
  });
});
