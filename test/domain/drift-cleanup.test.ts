// Issue #2715: a cleanup that keeps failing is a hopper bug, never a person's todo. The resource ledger against the ended
// jobs is a component watcher's drift: one kind per cause the reap named, each ended job one item, no path in it. A machine
// that is offline is no drift: bringing it online is the person's act, and its next pass reaps.
import { describe, expect, it } from 'vitest';
import { CLEANUP_LEDGER, cleanupDrift } from '../../src/domain/drift-cleanup.ts';
import type { CleanupLeftover, LedgerEntry } from '../../src/domain/resource-ledger.ts';

const ENDED = '2026-10-22T09:00:00.000Z';
const S = '/w/.worktrees/@scratch';
const failed = (jobId: string, reason: string, kind: LedgerEntry['kind'] = 'scratch_dir'): LedgerEntry =>
  ({ jobId, machineId: 'm1', kind, locator: `${S}/${jobId}`, createdAt: ENDED, state: 'failed', reason });
const leftover = (jobId: string, ...entries: LedgerEntry[]): CleanupLeftover => ({ jobId, endedAt: ENDED, entries });

describe('the resource ledger against the ended jobs (issue #2715)', () => {
  it('one drift per cause the reap named, each job once, with no path', () => {
    const drift = cleanupDrift([
      leftover('a', failed('a', `${S}/a is still there: it holds files of the job's user namespace that podman could not remove`), failed('a', `${S}/a is still there: it holds files of the job's user namespace that podman could not remove`, 'container_runtime')),
      leftover('b', failed('b', `${S}/b is still there: a process still runs in it`)),
      leftover('c', failed('c', `${S}/c is still there`)),
      leftover('d', failed('d', 'the reap on m1 failed: ssh: connection refused')),
    ]);
    expect(drift).toEqual([
      { watcher: CLEANUP_LEDGER, kind: 'cleanup_userns', items: [{ key: 'a', says: '2 things not removed', truth: 'job ended', since: ENDED }] },
      { watcher: CLEANUP_LEDGER, kind: 'cleanup_process', items: [{ key: 'b', says: '1 thing not removed', truth: 'job ended', since: ENDED }] },
      { watcher: CLEANUP_LEDGER, kind: 'cleanup_cause_unknown', items: [{ key: 'c', says: '1 thing not removed', truth: 'job ended', since: ENDED }] },
      { watcher: CLEANUP_LEDGER, kind: 'cleanup_reap_failed', items: [{ key: 'd', says: '1 thing not removed', truth: 'job ended', since: ENDED }] },
    ]);
    expect(JSON.stringify(drift)).not.toContain(S);
  });

  it('an entry not yet tried, or on a machine offline, is no drift', () => {
    expect(cleanupDrift([
      leftover('a', { ...failed('a', 'x'), state: 'live', reason: undefined }),
      leftover('b', failed('b', 'its machine m1 is offline')),
    ])).toEqual([]);
  });
});
