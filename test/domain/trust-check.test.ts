// Jev's trust check (issue #655 part 4): every option is at or below the job's level, so Jev can never raise it; a check
// with no sure pick lowers the job to `untrusted` (fail closed); the check is on the signed stamp; a person approves the
// trust of a job the check lowered, to `approved` and never more. Pure.
import { describe, expect, it } from 'vitest';
import { checkedLevel, pickedLevel, trustCheckState, trustOptions, CHECK_TEXT_MAX } from '../../src/domain/trust-check.ts';
import {
  checkDue, checkedStamp, quarantinedStamp, ruleCeiling, signStamp, stampHold, trustApprovable, trustApprovedStamp, verifiedLevel, TRUST_LEVELS, type TrustLevel,
} from '../../src/domain/trust-stamp.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const LATER = '2026-10-17T11:00:00.000Z';
const rank = (l: TrustLevel) => TRUST_LEVELS.indexOf(l);

const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});
const stamped = (j: Job): Job => ({ ...j, stamp: signStamp(KEY, j, { level: ruleCeiling(j).level, reasons: ruleCeiling(j).reasons, by: 'intake', at: AT }) });
const approvedJob = () => stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) }));
const applied = (pick: string, confidence = 0.95) => ({ asked: true as const, pickId: 'p', pick, confidence, applied: true });

describe('the options of intake-trust', () => {
  it('are keep and the levels below the job\'s, never above it and never quarantined', () => {
    for (const level of ['approved', 'trusted'] as const) {
      const ids = trustOptions(level).map((o) => o.id);
      expect(ids[0]).toBe('keep');
      const levels = ids.slice(1).map((id) => id.split(':')[1] as TrustLevel);
      expect(levels.every((l) => rank(l) < rank(level) && l !== 'quarantined')).toBe(true);
      expect(levels).toContain('untrusted');
    }
    expect(trustOptions('approved').map((o) => o.id)).not.toContain('lower:approved:touches_ci');
  });

  it('a pick that is no option gives no level: a forged raise is not one', () => {
    expect(pickedLevel('approved', 'lower:owner:unclear')).toBeUndefined();
    expect(pickedLevel('approved', 'lower:trusted:unclear')).toBeUndefined();
    expect(pickedLevel('approved', 'owner')).toBeUndefined();
    expect(pickedLevel('trusted', 'lower:screened:touches_ci')).toEqual({ level: 'screened', reason: 'touches_ci' });
    expect(pickedLevel('trusted', 'keep')).toEqual({ level: 'trusted' });
  });
});

describe('the level after the check (the point active)', () => {
  it('keeps the level, or lowers it with the reason', () => {
    expect(checkedLevel('trusted', applied('keep'))).toEqual({ level: 'trusted', check: { pick: 'keep', confidence: 0.95, applied: true } });
    expect(checkedLevel('trusted', applied('lower:untrusted:credentials'))).toMatchObject({ level: 'untrusted', reason: 'jev:credentials' });
  });

  it('fails closed: no pick, not sure, a pick that is no option, or Jev not asked gives untrusted', () => {
    expect(checkedLevel('approved', { asked: true, applied: false, notApplied: 'no_pick' })).toMatchObject({ level: 'untrusted', reason: 'jev:no_answer' });
    expect(checkedLevel('approved', { asked: true, pick: 'keep', confidence: 0.5, applied: false, notApplied: 'below_threshold' }))
      .toEqual({ level: 'untrusted', check: { pick: 'keep', confidence: 0.5, applied: false, fail: 'not_sure' }, reason: 'jev:not_sure' });
    expect(checkedLevel('approved', applied('lower:owner:unclear'))).toMatchObject({ level: 'untrusted', reason: 'jev:no_answer' });
    expect(checkedLevel('trusted', { asked: false })).toMatchObject({ level: 'untrusted', reason: 'jev:skipped', check: { applied: false, fail: 'skipped' } });
  });
});

describe('the check on the stamp', () => {
  it('is due for a job at approved or trusted that no person stamped, once', () => {
    expect(checkDue(KEY, approvedJob())).toBe(true);
    expect(checkDue(KEY, stamped(job('a', { source: github({ author: 'bob' }) })))).toBe(true);
    // An owner job is not asked; nor a job held already, nor one whose stamp does not verify.
    expect(checkDue(KEY, stamped(job('a', { source: github() })))).toBe(false);
    expect(checkDue(KEY, stamped(job('a', { source: github({ origin: undefined }) })))).toBe(false);
    expect(checkDue(KEY, { ...approvedJob(), stamp: { ...approvedJob().stamp!, level: 'trusted' } })).toBe(false);
    const j = approvedJob();
    const kept = { ...j, stamp: checkedStamp(KEY, j, applied('keep'), LATER) };
    expect(verifiedLevel(KEY, kept)).toBe('approved');
    expect(kept.stamp).toMatchObject({ by: 'jev', at: LATER, check: { pick: 'keep', applied: true } });
    expect(checkDue(KEY, kept)).toBe(false);
  });

  it('a changed check does not verify', () => {
    const j = approvedJob();
    const low = { ...j, stamp: checkedStamp(KEY, j, applied('lower:untrusted:touches_ci'), LATER)! };
    expect(verifiedLevel(KEY, low)).toBe('untrusted');
    expect(verifiedLevel(KEY, { ...low, stamp: { ...low.stamp, check: { applied: true, pick: 'keep' } } })).toBeUndefined();
    expect(verifiedLevel(KEY, { ...low, stamp: { ...low.stamp, level: 'approved' as const } })).toBeUndefined();
  });

  it('a job the check lowered is held with its reason, and a person approves it to approved', () => {
    const j = approvedJob();
    const low = { ...j, stamp: checkedStamp(KEY, j, applied('lower:untrusted:touches_ci'), LATER)! };
    expect(stampHold(KEY, low)).toBe('trust stamp untrusted is below approved (Jev\'s trust check: it changes CI, workflow files or branch rules): held — a person approves its trust on the job, or cancels it');
    expect(trustApprovable(KEY, low)).toBe(true);
    const ok = { ...low, stamp: trustApprovedStamp(KEY, low, LATER) };
    expect(verifiedLevel(KEY, ok)).toBe('approved');
    expect(ok.stamp).toMatchObject({ by: 'person', reasons: ['origin:approved', 'jev:touches_ci', 'person:approved'] });
    expect(stampHold(KEY, ok)).toBeUndefined();
    expect(checkDue(KEY, ok)).toBe(false);
    expect(trustApprovable(KEY, ok)).toBe(false);
  });

  it('a person approves no other job: one the rules hold, one the check kept, a quarantined one', () => {
    expect(trustApprovable(KEY, stamped(job('a', { source: github({ origin: undefined }) })))).toBe(false);
    const j = approvedJob();
    expect(trustApprovable(KEY, { ...j, stamp: checkedStamp(KEY, j, applied('keep'), LATER) })).toBe(false);
    const low = { ...j, stamp: checkedStamp(KEY, j, applied('lower:untrusted:unclear'), LATER) };
    expect(trustApprovable(KEY, { ...low, stamp: quarantinedStamp(KEY, low, LATER) })).toBe(false);
  });
});

describe('what Jev reads', () => {
  it('the job\'s facts and its text marked untrusted, cut at its limit', () => {
    const long = 'x'.repeat(CHECK_TEXT_MAX + 10);
    const j = job('a', { source: github({ origin: 'approved', author: 'stranger' }) });
    const s = trustCheckState({ ...j, spec: { ...j.spec, payload: { prompt: long } } }, 'approved', ['origin:approved']);
    expect(s).toMatchObject({ job: { id: 'a', level: 'approved' }, source: { kind: 'github-account', repo: 'o/r', author: 'stranger', origin: 'approved' }, textCut: long.length });
    expect((s.untrustedText as string).length).toBe(CHECK_TEXT_MAX);
  });
});
