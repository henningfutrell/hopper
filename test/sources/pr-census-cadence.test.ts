// The census's sync-loop half (issue #1176): at most once an hour for each source, at once on a sync a person asked for, never
// while the source is paused. What it says is tracked: a pull request a job of the source names, or one the ledger holds; an
// issue a job of the source has, or one the ledger holds.
import { describe, expect, it } from 'vitest';
import type { CensusFacts } from '../../src/domain/untracked-pull-requests.ts';
import type { JobSource } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { CENSUS_EVERY_MS, pullRequestCensus } from '../../src/sources/census.ts';
import { jobForIssue, REPO } from './fixtures/github-support.ts';

const PR = `https://github.com/${REPO}/pull/7`;
const LEDGER_PR = `https://github.com/${REPO}/pull/8`;
const LEDGER_ISSUE = `https://github.com/${REPO}/issues/9`;

function harness(paused?: string) {
  const at = { now: 0 };
  const asked: Omit<CensusFacts, 'landing'>[] = [];
  const source = { name: 'github', censusPullRequests: async (f: Omit<CensusFacts, 'landing'>) => { asked.push(f); }, paused: () => paused } as unknown as JobSource;
  const store = {
    jobs: { get: () => undefined },
    workItems: { get: (k: string) => (k === LEDGER_ISSUE ? {} : undefined), byPullRequest: (u: string) => (u === LEDGER_PR ? {} : undefined) },
  };
  const census = pullRequestCensus({ store: store as never, now: () => at.now });
  return { at, asked, census, source };
}

const jobs: Job[] = [jobForIssue(1, { status: 'finished', sourceState: { source: { pullRequest: PR, follow: 'open' } } })];

describe('the census in the sync loop (issue #1176)', () => {
  it('at most once an hour; a sync a person asked for runs it at once', async () => {
    const h = harness();
    await h.census(h.source, jobs, false);
    h.at.now = CENSUS_EVERY_MS - 1;
    await h.census(h.source, jobs, false);
    expect(h.asked).toHaveLength(1);
    await h.census(h.source, jobs, true);
    expect(h.asked).toHaveLength(2);
    h.at.now += CENSUS_EVERY_MS;
    await h.census(h.source, jobs, false);
    expect(h.asked).toHaveLength(3);
  });

  it('tracked: what a job names or the ledger holds; in Intake: a job\'s issue or a ledger item', async () => {
    const h = harness();
    await h.census(h.source, jobs, false);
    const f = h.asked[0]!;
    expect([f.tracked(PR), f.tracked(LEDGER_PR), f.tracked(`https://github.com/${REPO}/pull/10`)]).toEqual([true, true, false]);
    expect([f.issueTracked(`https://github.com/${REPO}/issues/1`), f.issueTracked(LEDGER_ISSUE), f.issueTracked(`https://github.com/${REPO}/issues/2`)])
      .toEqual([true, true, false]);
  });

  it('paused: none', async () => {
    const h = harness('not connected');
    await h.census(h.source, jobs, true);
    expect(h.asked).toEqual([]);
  });
});
