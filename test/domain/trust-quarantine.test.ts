// Quarantine (issue #655, part 2): a person sets a job's trust level to `quarantined`, signed as every stamp is. A
// quarantined job is held, and its proxy token opens no door; a job whose stamp does not verify opens none either. Lifting
// the quarantine gives back the level the job had before it, never more. Pure.
import { describe, expect, it } from 'vitest';
import {
  liftedStamp, opensDoors, QUARANTINED_HOLD, quarantinedStamp, ruleCeiling, signStamp, stampHold, verifiedLevel,
} from '../../src/domain/trust-stamp.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const LATER = '2026-10-17T11:00:00.000Z';

const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});
const stamped = (j: Job): Job => ({ ...j, stamp: signStamp(KEY, j, { level: ruleCeiling(j).level, reasons: ruleCeiling(j).reasons, by: 'intake', at: AT }) });

describe('quarantine', () => {
  it('signs the job quarantined, by a person, and keeps the level it had', () => {
    const j = stamped(job('a', { source: github() }));
    const q = { ...j, stamp: quarantinedStamp(KEY, j, LATER) };
    expect(q.stamp).toMatchObject({ v: 1, level: 'quarantined', was: 'owner', by: 'person', at: LATER, reasons: ['origin:trusted', 'author:assignee', 'quarantined'] });
    expect(verifiedLevel(KEY, q)).toBe('quarantined');
    expect(stampHold(KEY, q)).toBe(QUARANTINED_HOLD);
  });

  it('a raised `was` does not verify', () => {
    const j = stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) }));
    const q = { ...j, stamp: quarantinedStamp(KEY, j, LATER) };
    expect(verifiedLevel(KEY, { ...q, stamp: { ...q.stamp, was: 'owner' as const } })).toBeUndefined();
  });

  it('a job whose stamp does not verify is quarantined with no level to go back to', () => {
    const j = job('a', { source: github() });
    expect(quarantinedStamp(KEY, j, LATER)).toMatchObject({ level: 'quarantined', reasons: ['quarantined'] });
    expect(quarantinedStamp(KEY, j, LATER).was).toBeUndefined();
  });

  it('lifted: the level it had before, its reasons as they were', () => {
    const j = stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) }));
    const q = { ...j, stamp: quarantinedStamp(KEY, j, LATER) };
    const lifted = { ...q, stamp: liftedStamp(KEY, q, LATER) };
    expect(lifted.stamp).toMatchObject({ level: 'approved', reasons: ['origin:approved'], by: 'person', at: LATER });
    expect(lifted.stamp.was).toBeUndefined();
    expect(stampHold(KEY, lifted)).toBeUndefined();
  });

  it('lifted with no level to go back to: the rules\' level', () => {
    const q = { ...job('a', { source: github() }), stamp: quarantinedStamp(KEY, job('a', { source: github() }), LATER) };
    expect(liftedStamp(KEY, q, LATER)).toMatchObject({ level: 'owner', reasons: ['origin:trusted', 'author:assignee'] });
  });
});

describe('the doors a proxy token opens', () => {
  it('open for a stamp that verifies, at any level but quarantined', () => {
    const j = stamped(job('a', { source: github() }));
    expect(opensDoors(KEY, j)).toBe(true);
    expect(opensDoors(KEY, stamped(job('b', { source: github({ origin: undefined }) })))).toBe(true);
    expect(opensDoors(KEY, { ...j, stamp: quarantinedStamp(KEY, j, LATER) })).toBe(false);
  });

  it('closed for no stamp, or one that does not verify', () => {
    const j = stamped(job('a', { source: github() }));
    expect(opensDoors(KEY, job('a'))).toBe(false);
    expect(opensDoors(KEY, { ...j, id: 'b' })).toBe(false);
  });
});
