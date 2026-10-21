// The label mirror runs on one host at a time (issue #1892, milestone 2): of the hoppers on one database, only the holder
// of the source's mirror lease corrects labels and records a label taken off by hand. Another host reads the same issues
// and judges Intake, and writes nothing. When the holder stops, the next host takes the lease and goes on: an end label
// taken off by hand meanwhile is its Run again, once, and not put back.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/sources/github/index.ts';
import { memoryListings } from '../../src/sources/github/listing.ts';
import { PR_CLOSED } from '../../src/sources/github/discover.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { REPO } from './fixtures/github-support.ts';
import { labelMirrorSetup as setup, url } from './fixtures/label-mirror-support.ts';

const prClosed = (n: number): Partial<WorkItem> => ({ blockedCause: 'pr_closed', closedWithoutMerge: 1, jobId: `job-${n}` });

describe('the label mirror under its lease (issue #1892)', () => {
  it('a host that does not hold the lease corrects no label; the holder does, and is no edit to the next holder', async () => {
    const gh = createFakeGitHub();
    const items = { [url(1)]: prClosed(1) };
    let otherHolds = false;
    const other = setup(items, { gh, held: () => otherHolds });
    const holder = setup(items, { gh, held: () => true });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-ready'] });
    await other.source.discover();
    expect(other.reason(1)?.reason).toBe(PR_CLOSED);
    expect(await other.source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-ready']);
    await holder.source.discover();
    await holder.source.flushOutbox!();
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper', 'hopper:pr-closed']);
    // The other sees the corrected labels, then takes the lease: the holder's correction is no edit by hand.
    other.later(60_000);
    await other.source.discover();
    otherHolds = true;
    other.later(60_000);
    await other.source.discover();
    expect(other.edits()).toEqual([]);
    expect(await other.source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
  });

  it('a label taken off by hand is recorded by the holder only', async () => {
    const gh = createFakeGitHub();
    const items = { [url(1)]: prClosed(1) };
    const other = setup(items, { gh, held: () => false });
    const holder = setup(items, { gh, held: () => true });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    await other.source.discover();
    await holder.source.discover();
    gh.removeLabel(REPO, 1, 'hopper:pr-closed');
    for (const h of [other, holder]) h.later(60_000);
    await other.source.discover();
    expect(other.edits()).toEqual([]);
    await holder.source.discover();
    expect(holder.edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'blocked', label: 'hopper:pr-closed', means: 'run_again' }]);
  });

  it('the holder stops: the next host takes the lease, records the label taken off meanwhile once, and does not put it back', async () => {
    const gh = createFakeGitHub();
    const listings = memoryListings();
    const items = { [url(1)]: prClosed(1) };
    let held = false;
    const first = setup(items, { gh, listings, held: () => true });
    gh.createIssue({ repo: REPO, assignees: ['owner'], labels: ['hopper', 'hopper:pr-closed'] });
    await first.source.discover();
    const next = setup(items, { gh, listings, held: () => held, at: '2026-10-18T12:01:00.000Z' });
    await next.source.discover();
    // The first host stops; a person takes the label off before the next host holds the lease.
    gh.removeLabel(REPO, 1, 'hopper:pr-closed');
    next.later(60_000);
    await next.source.discover();
    expect(next.edits()).toEqual([]);
    held = true;
    next.later(60_000);
    await next.source.discover();
    expect(next.edits()).toEqual([{ source: 'github', key: url(1), jobId: 'job-1', from: 'blocked', label: 'hopper:pr-closed', means: 'run_again' }]);
    next.later(60_000);
    await next.source.discover();
    expect(await next.source.flushOutbox!()).toEqual({ due: 0, wrote: [] });
    expect(gh.issue(REPO, 1).labels).toEqual(['hopper']);
    expect(next.edits()).toHaveLength(1);
  });
});
