// Yolo mode does not merge a held change (issue #2775 part 7, design.md "Part 6: interventions and the delivery hold"): a
// job's own pull request that is ready by its checks waits while a delivery hold holds the job's change, and says why
// (`mergeError`). A release lets the next sync merge it. A person's Merge now is a person's act, and still merges.
//
// Feature: yolo mode skips a held change
//   Scenario: a held change is not merged; the wait says why
//   Scenario: released: the next sync merges it
//   Scenario: a person's Merge now still merges a held change
import { describe, expect, it } from 'vitest';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const LONG_AGO = '2026-10-02T09:50:00.000Z';
const WHY = 'its delivery is held: paused at pr_checks since 2026-10-02T09:55:00.000Z; a release lets it go on';

async function ended(hold: { why?: string }) {
  const s = setup({}, { yoloMode: () => true, deliveryHold: () => hold.why });
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  s.gh.openPullRequest(REPO, 1, { createdAt: LONG_AGO, checks: 'passing' });
  const base = jobForIssue(1, { status: 'finished', createdAt: '2026-10-02T09:00:00.000Z' });
  const state = await s.source.report({ kind: 'finished', job: base });
  return { ...s, job: { ...base, sourceState: { source: state } } };
}

const merges = (gh: Awaited<ReturnType<typeof ended>>['gh']) => gh.calls.filter((c) => c.method === 'merge').length;

describe('yolo mode does not merge a held change (issue #2775 part 7)', () => {
  it('a held change is not merged; the wait says why', async () => {
    const { gh, source, job } = await ended({ why: WHY });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { mergeError: WHY } } });
    expect(merges(gh)).toBe(0);
  });

  it('released: the next sync merges it', async () => {
    const hold: { why?: string } = { why: WHY };
    const { gh, source, job } = await ended(hold);
    const waited = await source.follow!(job);
    delete hold.why;
    expect(await source.follow!({ ...job, sourceState: { source: waited!.state } })).toMatchObject({ outcome: 'merged', byHopper: true });
    expect(merges(gh)).toBe(1);
  });

  it("a person's Merge now still merges a held change", async () => {
    const { gh, source, job } = await ended({ why: WHY });
    expect(await source.follow!(job, 'merge')).toMatchObject({ outcome: 'merged' });
    expect(merges(gh)).toBe(1);
  });
});
