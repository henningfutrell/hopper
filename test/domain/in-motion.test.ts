// In motion (issue #985): an open pull request a job follows that the in-motion cycle reads every few minutes — not seen
// yet, its checks still running, no checks but still in the grace window, or ready while the hopper merges it. Every other
// followed pull request is idle: read only on the reconcile round.
import { describe, expect, it } from 'vitest';
import { inMotion, NO_CHECKS_GRACE_MS, type Job, type PullRequestSeen } from '../../src/domain/types.ts';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const job = (seen: PullRequestSeen | undefined, follow = 'open'): Job => ({
  id: 'j', status: 'finished', source: { source: 'github', kind: 'github', key: 'k', repo: 'o/r', number: 1 },
  sourceState: { source: { pullRequest: 'https://github.com/o/r/pull/2', follow, ...(seen ? { seen } : {}) } },
} as unknown as Job);
const seen = (s: Partial<PullRequestSeen>): PullRequestSeen => ({ draft: false, conflicting: false, checks: 'passing', ...s });
const yolo = () => true;
const noYolo = () => false;

describe('inMotion', () => {
  it('a followed pull request not seen yet, or with checks still running, is in motion', () => {
    expect(inMotion(job(undefined), noYolo, NOW)).toBe(true);
    expect(inMotion(job(seen({ checks: 'pending' })), noYolo, NOW)).toBe(true);
  });

  it('no checks is in motion only in the grace window after its last push', () => {
    expect(inMotion(job(seen({ checks: 'none', pushedAt: new Date(NOW - 1000).toISOString() })), noYolo, NOW)).toBe(true);
    expect(inMotion(job(seen({ checks: 'none', pushedAt: new Date(NOW - NO_CHECKS_GRACE_MS).toISOString() })), noYolo, NOW)).toBe(false);
  });

  it('ready is in motion only while the hopper merges on ready (yolo mode)', () => {
    expect(inMotion(job(seen({})), yolo, NOW)).toBe(true);
    expect(inMotion(job(seen({})), noYolo, NOW)).toBe(false);
  });

  it('idle: checks finished and not ready to merge, a draft, merge conflicts, failing or unknown checks', () => {
    for (const s of [seen({ draft: true }), seen({ conflicting: true }), seen({ checks: 'failing' }), seen({ checks: 'unknown' })]) {
      expect(inMotion(job(s), yolo, NOW)).toBe(false);
    }
  });

  it('a pull request the job follows no more is never in motion: merged, closed, tended', () => {
    for (const f of ['merged', 'closed', 'tended', 'abandoned']) expect(inMotion(job(seen({ checks: 'pending' }), f), yolo, NOW)).toBe(false);
  });
});
