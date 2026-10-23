// Issue #2504 part 12: an ended job's cleanup leftover on a retired machine (issue #919: one gone from the plugins config,
// that no machine source lists) is closed `retired` after the leftover check told it: no reap can reach it. Pure.
import { describe, expect, it } from 'vitest';
import { cleanupLeftoversOf, cleanupStatusOf, goneClosures, ledgerParts, reapClosures, retiredClosures, retiredReasonOf, type CleanupLeftover, type LedgerEntry } from '../../src/domain/resource-ledger.ts';

const AT = '2026-10-22T10:00:00.000Z';
const SCRATCH = '/w/.worktrees/@scratch/j1';

const entry = (machineId: string, over: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ jobId: 'j1', machineId, kind: 'scratch_dir', locator: SCRATCH, createdAt: AT, state: 'live', ...over });
const leftover = (...entries: LedgerEntry[]): CleanupLeftover => ({ jobId: 'j1', endedAt: AT, entries });

describe('retiredClosures', () => {
  it('closes each told entry on a machine neither listed nor configured, with why', () => {
    const gone = entry('box-7'), here = entry('m1', { kind: 'job_scope', locator: 'hopper-job-j1.scope' });
    expect(retiredClosures([leftover(gone, here)], ['m1'], [])).toEqual([{ entry: gone, state: 'retired', reason: retiredReasonOf('box-7') }]);
    expect(retiredReasonOf('box-7')).toBe('its machine box-7 is retired: it is no longer configured, so no reap reaches it');
  });

  it('keeps an entry whose machine is configured though no source lists it now (offline, or its instance did not build)', () => {
    expect(retiredClosures([leftover(entry('desk'))], [], ['desk'])).toEqual([]);
  });

  it('judges nothing while the plugins config has an error', () => {
    expect(retiredClosures([leftover(entry('box-7'))], [], undefined)).toEqual([]);
  });
});

describe('a retired entry', () => {
  const retired = entry('box-7', { state: 'retired', reason: retiredReasonOf('box-7'), endedAt: AT });

  it('is no cleanup leftover', () => {
    expect(cleanupLeftoversOf([retired], () => ({ status: 'failed', finishedAt: AT, updatedAt: AT }), Date.parse(AT) + 86_400_000)).toEqual([]);
  });

  it('is judged again by a reap or the reconciler there, should the machine come back under its name', () => {
    expect(reapClosures([retired], { kept: [] }).map((c) => c.state)).toEqual(['reaped']);
    expect(goneClosures([retired], { scratch: [], scopes: [], processes: [], roots: ['/w'] }, 'box-7', () => ({ status: 'failed' })).map((c) => c.state)).toEqual(['reaped']);
  });

  it('gives the job the cleanup status machine_retired, shown on the parts list', () => {
    const ended = { status: 'failed' as const };
    const scope = entry('box-7', { kind: 'job_scope', locator: 'hopper-job-j1.scope', state: 'reaped' });
    expect(cleanupStatusOf(ended, [retired, scope])).toBe('machine_retired');
    expect(cleanupStatusOf(ended, [retired, entry('m1', { state: 'failed', reason: 'x' })])).toBe('failed');
    expect(cleanupStatusOf(ended, [retired, entry('m1', { state: 'kept' })])).toBe('machine_retired');
    const parts = ledgerParts(ended, [retired, scope]);
    expect(parts[0]).toMatchObject({ id: 'cleanup', status: 'open', label: 'Cleanup: its machine is retired, so what it holds there was not removed', detail: '2 of 2 closed' });
    expect(parts[1]).toMatchObject({ kind: 'scratch_dir', status: 'recorded', detail: `${SCRATCH}: not removed: its machine is retired (${retiredReasonOf('box-7')})` });
  });
});
