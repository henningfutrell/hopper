// The delivery hold's effect on the batch runner and the canary (issue #2775 part 7, design.md "Part 6: interventions and
// the delivery hold"): a held change is not taken into a batch run, and `stable` does not move to a candidate that carries
// one. The landing branch is one line, so the batch run takes it up to the first held merge, and the changes after it wait
// with it. A release lets the next pass go on. Fake GitHub at the LandingBatchGitHub seam.
//
// Feature: the batch runner and the canary skip a held change
//   Scenario: a held merge in the middle: the batch run takes the landing branch up to it
//   Scenario: the first merge is held: no batch run starts, and the pass says why
//   Scenario: released: the next batch run takes the landing tip
//   Scenario: the canary window passed, but the candidate carries a held change: stable does not move until it is released
import { describe, expect, it } from 'vitest';
import type { LandingBatchSettings } from '../../src/domain/landing-batches.ts';
import type { DomainEvent, NewEvent } from '../../src/domain/types.ts';
import { createLandingBatches, type LandingBatchGitHub } from '../../src/landing-batches/runner.ts';

const REPO = 'owner/app';
const BASE = 'b0';
// The landing branch beyond dev: three merges, each on the one before it.
const COMMITS = [
  { sha: 'm12', parents: [BASE, 'x'], message: 'Merge pull request #12 from owner/issue-1-a' },
  { sha: 'm14', parents: ['m12', 'y'], message: 'Merge pull request #14 from owner/issue-2-b' },
  { sha: 'm16', parents: ['m14', 'z'], message: 'Merge pull request #16 from owner/issue-3-c' },
];
const START = new Date('2026-10-25T00:00:00.000Z');

interface World { calls: string[]; held: Set<number>; quiet?: boolean }

function fake(w: World): LandingBatchGitHub {
  const no = async (): Promise<never> => { throw new Error('not in this test'); };
  return {
    compare: async (_repo, base, head) => {
      w.calls.push(`compare ${base}...${head}`);
      if (base === 'stable') return { aheadBy: 3, tip: 'm16', commits: COMMITS };
      if (w.quiet) return { aheadBy: 0, tip: BASE, commits: [] };
      const upTo = head === 'main' ? COMMITS.length : COMMITS.findIndex((c) => c.sha === head) + 1;
      const commits = COMMITS.slice(0, upTo);
      return { aheadBy: commits.length, tip: commits.at(-1)?.sha ?? BASE, commits };
    },
    createBranch: async (_repo, name, sha) => { w.calls.push(`branch ${name} ${sha}`); },
    openPullRequest: async (_repo, p) => { w.calls.push(`open ${p.head} -> ${p.base}`); return { number: 100, url: `https://github.test/${REPO}/pull/100` }; },
    openPullRequests: async () => [], findIssue: async () => undefined, pullRequestOf: async () => undefined, bugReports: async () => [],
    fastForward: async (_repo, branch, sha) => { w.calls.push(`fast-forward ${branch} ${sha}`); },
    deleteBranch: no, pullRequest: no, checkRuns: no, merge: no, close: no, mergeInto: no, retarget: no, comment: no, revert: no, checkLog: no, fileIssue: no,
  };
}

function runner(w: World, settings: LandingBatchSettings, events: DomainEvent[] = []) {
  let seq = events.length;
  let now = START;
  const r = createLandingBatches({
    github: () => fake(w), login: () => 'me', settings: () => settings, events: () => events,
    record: (e: NewEvent) => { events.push({ ...e, seq: ++seq, id: `e${seq}`, at: now.toISOString(), schemaVersion: 1 } as DomainEvent); },
    jobPullRequests: () => [], held: (repo) => (repo === REPO ? w.held : new Set()), now: () => now, log: () => {},
  });
  return { r, events, at: (d: Date) => { now = d; } };
}

const BATCHES: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 1, everyMinutes: 60 } } };
const started = (events: DomainEvent[]) => events.filter((e) => e.type === 'landing_batch.started').map((e) => e.data);

describe('the batch runner skips a held change (issue #2775 part 7)', () => {
  it('a held merge in the middle: the batch run takes the landing branch up to it', async () => {
    const w: World = { calls: [], held: new Set([14]) };
    const { r, events } = runner(w, BATCHES);
    await r.pass();
    expect(started(events)).toEqual([expect.objectContaining({ tip: 'm12', merges: [12] })]);
    expect(w.calls.filter((c) => c.startsWith('branch '))).toEqual([expect.stringMatching(/m12 m12$/)]);
    expect(r.view().repos[0]).toMatchObject({ why: expect.stringContaining('#14 is held: the batch run takes the landing branch up to it') });
  });

  it('the first merge is held: no batch run starts, and the pass says why', async () => {
    const w: World = { calls: [], held: new Set([12]) };
    const { r, events } = runner(w, BATCHES);
    await r.pass();
    expect(started(events)).toEqual([]);
    expect(w.calls.filter((c) => c.startsWith('branch'))).toEqual([]);
    expect(r.view().repos[0]).toMatchObject({ why: expect.stringContaining('#12 is held: the batch run takes the landing branch up to it') });
  });

  it('released: the next batch run takes the landing tip', async () => {
    const w: World = { calls: [], held: new Set([12]) };
    const { r, events } = runner(w, BATCHES);
    await r.pass();
    w.held.clear();
    await r.pass();
    expect(started(events)).toEqual([expect.objectContaining({ tip: 'm16', merges: [12, 14, 16] })]);
  });
});

describe('the canary skips a held change (issue #2775 part 7)', () => {
  it('the window passed, but the candidate carries a held change: stable does not move until it is released', async () => {
    const w: World = { calls: [], held: new Set(), quiet: true };
    const settings: LandingBatchSettings = { repos: { [REPO]: { tested: 'dev', everyMerges: 99, everyMinutes: 9999, canaryHours: 24 } } };
    const { r, events, at } = runner(w, settings);
    await r.pass();
    expect(events.map((e) => e.type)).toContain('landing_batch.canary_started');
    w.held.add(14);
    at(new Date(START.getTime() + 25 * 3_600_000));
    await r.pass();
    expect(w.calls.filter((c) => c.startsWith('fast-forward'))).toEqual([]);
    expect(events.map((e) => e.type)).not.toContain('landing_batch.canary_promoted');
    expect(r.view().repos[0]!.canary).toMatchObject({ why: 'stable waits: the candidate m16 carries #14, and its delivery is held' });
    w.held.clear();
    await r.pass();
    expect(w.calls).toContain('fast-forward stable m16');
  });
});
