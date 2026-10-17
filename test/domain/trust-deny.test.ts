// Gate 2's denies (issue #655, part 5): a person who declines a job's sandbox request lowers the job's trust one level,
// signed as every stamp is; the second deny in the job, or a deny of a job at `untrusted`, quarantines it. A job a deny
// lowered below `approved` waits for a person's approval of its trust. Pure.
import { describe, expect, it } from 'vitest';
import {
  DENY_REASON, deniedStamp, liftedStamp, opensDoors, ruleCeiling, signStamp, stampHold, trustApprovable, trustApprovedStamp, verifiedLevel, type TrustStamp,
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
type Stamped = Job & { stamp: TrustStamp };
const denied = (j: Job): Stamped => ({ ...j, stamp: deniedStamp(KEY, j, LATER)! });

describe('a person\'s deny at gate 2', () => {
  it('lowers the level one step, by a person, with the deny reason', () => {
    const j = denied(stamped(job('a', { source: github() })));
    expect(j.stamp).toMatchObject({ v: 1, level: 'trusted', by: 'person', at: LATER, reasons: ['origin:trusted', 'author:assignee', DENY_REASON] });
    expect(verifiedLevel(KEY, j)).toBe('trusted');
    expect(opensDoors(KEY, j)).toBe(true);
  });

  it('the second deny quarantines the job, its level before kept', () => {
    const j = denied(denied(stamped(job('a', { source: github() }))));
    expect(j.stamp).toMatchObject({ level: 'quarantined', was: 'trusted', by: 'person' });
    expect(opensDoors(KEY, j)).toBe(false);
    const lifted = { ...j, stamp: liftedStamp(KEY, j, LATER) };
    expect(lifted.stamp.level).toBe('trusted');
    // Lifted, the job keeps its two denies: the next one quarantines it again.
    expect(denied(lifted).stamp.level).toBe('quarantined');
  });

  it('a deny of an untrusted job quarantines it', () => {
    const j = denied(stamped(job('a', { source: github({ origin: undefined }) })));
    expect(j.stamp).toMatchObject({ level: 'quarantined', was: 'untrusted' });
  });

  it('gives nothing for a job quarantined already, or a stamp that does not verify', () => {
    const q = denied(denied(stamped(job('a', { source: github() }))));
    expect(deniedStamp(KEY, q, LATER)).toBeUndefined();
    expect(deniedStamp(KEY, job('b', { source: github() }), LATER)).toBeUndefined();
    const j = stamped(job('c', { source: github() }));
    expect(deniedStamp(KEY, { ...j, id: 'd' }, LATER)).toBeUndefined();
  });

  it('below approved, the job waits for a person to approve its trust, who signs approved', () => {
    const j = denied(stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) })));
    expect(j.stamp.level).toBe('screened');
    expect(stampHold(KEY, j)).toBe('trust stamp screened is below approved (a person declined its sandbox request): held — a person approves its trust on the job, or cancels it');
    expect(trustApprovable(KEY, j)).toBe(true);
    const approved = { ...j, stamp: trustApprovedStamp(KEY, j, LATER) };
    expect(approved.stamp).toMatchObject({ level: 'approved', by: 'person' });
    expect(stampHold(KEY, approved)).toBeUndefined();
    expect(trustApprovable(KEY, approved)).toBe(false);
    // Approved, the deny stays on the stamp: the next one quarantines it.
    expect(denied(approved).stamp.level).toBe('quarantined');
  });

  it('a raised level after a deny does not verify', () => {
    const j = denied(stamped(job('a', { source: github() })));
    expect(verifiedLevel(KEY, { ...j, stamp: { ...j.stamp, level: 'owner' as const } })).toBeUndefined();
  });
});
