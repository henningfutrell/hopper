// The retention per job status (issue #2494, design.md "The sweep"): how long an ended job's scratch dir and job worktrees
// stay on its machine. Set for the status, counted from the job's end; not set, the sweep's scratch age, as before.
import { describe, expect, it } from 'vitest';
import { retainedUntilOf, retainsAtEnd, retentionOver } from '../../src/domain/retention.ts';
import type { Job } from '../../src/domain/types.ts';

const HOUR = 3600_000;
const NOW = Date.parse('2026-10-08T00:00:00Z');
const ended = (status: Job['status'], hoursAgo?: number): Job => ({
  id: 'j', spec: { executor: 'x', payload: {} }, priority: 50, status, approved: false, createdAt: '', updatedAt: '', attempts: 1,
  ...(hoursAgo !== undefined ? { finishedAt: new Date(NOW - hoursAgo * HOUR).toISOString() } : {}),
});

describe('the retention per job status (issue #2494)', () => {
  it('not set: the dir goes once it is the sweep\'s scratch age old (default 24 h)', () => {
    expect(retentionOver(undefined, ended('failed', 1), 25 * HOUR, NOW)).toBe(true);
    expect(retentionOver(undefined, ended('failed', 30), 23 * HOUR, NOW)).toBe(false);
    expect(retentionOver({ scratchMaxAgeHours: 2 }, ended('finished', 1), 3 * HOUR, NOW)).toBe(true);
  });

  it('set for the status: counted from the job\'s end, whatever the dir\'s age', () => {
    const s = { scratchMaxAgeHours: 2, retainHours: { failed: 48 } };
    expect(retentionOver(s, ended('failed', 47), 99 * HOUR, NOW)).toBe(false);
    expect(retentionOver(s, ended('failed', 49), 1 * HOUR, NOW)).toBe(true);
    // Another status falls back to the scratch age.
    expect(retentionOver(s, ended('finished', 1), 3 * HOUR, NOW)).toBe(true);
  });

  it('set to 0: the work goes at the next sweep', () => {
    expect(retentionOver({ retainHours: { cancelled: 0 } }, ended('cancelled', 0), 0, NOW)).toBe(true);
  });

  it('a job with no end time is judged by its dir\'s age', () => {
    expect(retentionOver({ retainHours: { failed: 48 } }, ended('failed'), 47 * HOUR, NOW)).toBe(false);
    expect(retentionOver({ retainHours: { failed: 48 } }, ended('failed'), 49 * HOUR, NOW)).toBe(true);
  });

  it('the reap at the job\'s end keeps the scratch dir only when a retention above 0 is set for its status', () => {
    expect(retainsAtEnd(undefined, 'failed')).toBe(false);
    expect(retainsAtEnd({ retainHours: { failed: 24 } }, 'failed')).toBe(true);
    expect(retainsAtEnd({ retainHours: { failed: 24 } }, 'finished')).toBe(false);
    expect(retainsAtEnd({ retainHours: { finished: 0 } }, 'finished')).toBe(false);
    expect(retainsAtEnd({ retainHours: { failed: 24 } }, 'running')).toBe(false);
  });

  it('the ledger keeps the reap\'s kept dirs until the retention ends; a timed-out job\'s until the dir is old enough (issue #2504 part 5)', () => {
    const end = new Date(NOW - HOUR).toISOString();
    const at = (h: number) => new Date(NOW - HOUR + h * HOUR).toISOString();
    expect(retainedUntilOf({ retainHours: { failed: 24 } }, { status: 'failed', finishedAt: end }, NOW)).toBe(at(24));
    expect(retainedUntilOf({ retainHours: { failed: 24 } }, { status: 'failed' }, NOW)).toBe(new Date(NOW + 24 * HOUR).toISOString());
    expect(retainedUntilOf(undefined, { status: 'failed', finishedAt: end }, NOW)).toBeUndefined();
    expect(retainedUntilOf({ retainHours: { failed: 0 } }, { status: 'failed', finishedAt: end }, NOW)).toBeUndefined();
    expect(retainedUntilOf(undefined, { status: 'failed', finishedAt: end, liveness: { outputAt: end } }, NOW)).toBe(at(24));
    expect(retainedUntilOf({ scratchMaxAgeHours: 6 }, { status: 'failed', finishedAt: end, liveness: { outputAt: end } }, NOW)).toBe(at(6));
  });
});
