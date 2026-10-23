// The sweep closes a job's resource ledger (issue #2504) as each of its reaps says: kept work a later reap removed is
// reaped, a dir it could not remove failed with why, and a reap that did not look at the scratch dir closes the scope only.
import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../../src/domain/resource-ledger.ts';
import { HOUR, none, rig } from './sweep-rig.ts';

const entry = (jobId: string, kind: LedgerEntry['kind'], locator: string, state: LedgerEntry['state'] = 'live'): LedgerEntry =>
  ({ jobId, machineId: 'm', kind, locator, createdAt: '2026-10-07T00:00:00.000Z', state });

describe('the sweep and the resource ledger (issue #2504)', () => {
  it('closes the entries of a job whose scratch dir it reaped: kept work now removed is reaped', async () => {
    const r = rig({ kept: ['done'], found: { ...none, scratch: [{ jobId: 'done', path: '/w/.worktrees/@scratch/done', ageMs: 25 * HOUR }] },
      ledger: [entry('done', 'scratch_dir', '/w/.worktrees/@scratch/done', 'kept'), entry('done', 'job_scope', 'hopper-job-done.scope')] });
    await r.sweep.run(true);
    expect(r.ledger.map((e) => [e.kind, e.state, e.endedAt])).toEqual([['scratch_dir', 'reaped', '2026-10-08T00:00:00.000Z'], ['job_scope', 'reaped', '2026-10-08T00:00:00.000Z']]);
  });

  it('fails an entry whose dir the reap could not remove, with why', async () => {
    const r = rig({ lefts: ['done'], found: { ...none, scratch: [{ jobId: 'done', path: '/w/.worktrees/@scratch/done', ageMs: 25 * HOUR }] },
      ledger: [entry('done', 'scratch_dir', '/w/.worktrees/@scratch/done')] });
    await r.sweep.run(true);
    expect(r.ledger[0]).toMatchObject({ state: 'failed', reason: '/w/.worktrees/@scratch/done is still there' });
  });

  it('closes only the scope when the reap did not look at the scratch dir', async () => {
    const r = rig({ found: { ...none, scopes: ['old'] }, ledger: [entry('old', 'scratch_dir', '/w/.worktrees/@scratch/old'), entry('old', 'job_scope', 'hopper-job-old.scope')] });
    await r.sweep.run(true);
    expect(r.reaps).toEqual([{ jobId: 'old' }]);
    expect(r.ledger.map((e) => [e.kind, e.state])).toEqual([['scratch_dir', 'live'], ['job_scope', 'reaped']]);
  });

  it('reaps an entry whose dir is no longer on the machine (removed by hand), so it is no leftover', async () => {
    const r = rig({ found: { ...none, roots: ['/w'], trees: [] }, ledger: [entry('old', 'scratch_dir', '/w/.worktrees/@scratch/old', 'failed'), entry('old', 'job_worktree', '/w/.worktrees/app/old'), entry('run', 'scratch_dir', '/v/.worktrees/@scratch/run')] });
    await r.sweep.run(true);
    expect(r.ledger.map((e) => [e.jobId, e.kind, e.state, e.reason])).toEqual([
      ['old', 'scratch_dir', 'reaped', 'not found on the machine'], ['old', 'job_worktree', 'reaped', 'not found on the machine'], ['run', 'scratch_dir', 'live', undefined],
    ]);
  });

  it('reaps the entries of kept work that is gone from the machine', async () => {
    const r = rig({ kept: ['done'], found: { ...none, roots: ['/w'], trees: [] }, ledger: [entry('done', 'scratch_dir', '/w/.worktrees/@scratch/done', 'kept')] });
    await r.sweep.run(true);
    expect(r.ledger[0]).toMatchObject({ state: 'reaped' });
  });
});
