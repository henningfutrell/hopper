// Listed reads (issue #985 part 2) keep a copy of each listed issue a job read. An issue that left the listing is read
// from GitHub anyway, so its copy goes at the end of each discover or check (issue #1402): what is kept follows the
// listing, not every issue ever read.
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/sources/github/index.ts';
import { createIntakeListing, memoryListings } from '../../src/sources/github/listing.ts';
import { listedReads, type Kept } from '../../src/sources/github/listed-reads.ts';
import { REPO } from './fixtures/github-support.ts';

describe('listed reads keep only what the listing holds (issue #1402)', () => {
  it('drops the copies of an issue that left the listing at the end of a cached run', async () => {
    const gh = createFakeGitHub();
    const listings = memoryListings();
    const listing = createIntakeListing({ api: gh, listings, clock: { now: () => new Date('2026-10-14T18:00:00.000Z') }, everyMs: () => 15 * 60_000 });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    gh.createIssue({ repo: REPO, labels: ['hopper'] });
    await listing.issues([REPO], 'hopper', true);
    const kept = new Map<string, Kept>();
    const reads = listedReads(gh, listings, kept);
    await reads.cached(async () => { await reads.api.getIssue(REPO, 1); await reads.api.getIssue(REPO, 2); await reads.api.listComments(REPO, 2); });
    expect(kept.size).toBe(3);
    const l = listings.listing(REPO)!;
    listings.record(REPO, { ...l, items: l.items.filter((i) => i.number === 1) });
    await reads.cached(async () => undefined);
    expect([...kept.keys()]).toEqual([`getIssue ${REPO}#1`]);
  });
});
