// An edit at gate 1 after the start (issue #655, part 7): a sync that sees a started job's item edited lowers the job's
// trust to `untrusted`, signed as every stamp is; a person approves its trust again. Below `approved`, gate 2 gives the
// job nothing with no person: its automatic approvals need `approved` or above. Pure.
import { describe, expect, it } from 'vitest';
import {
  autoApprovable, EDIT_REASON, editedStamp, quarantinedStamp, ruleCeiling, signStamp, stampHold, trustApprovable, trustApprovedStamp, verifiedLevel, type TrustStamp,
} from '../../src/domain/trust-stamp.ts';
import { brakeOf, DEFAULT_INTAKE_STRICTNESS } from '../../src/domain/intake-strictness.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const LATER = '2026-10-17T11:00:00.000Z';
const STANDARD = brakeOf(DEFAULT_INTAKE_STRICTNESS, undefined);

const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});
const stamped = (j: Job): Job => ({ ...j, stamp: signStamp(KEY, j, { level: ruleCeiling(j).level, reasons: ruleCeiling(j).reasons, by: 'intake', at: AT }) });
type Stamped = Job & { stamp: TrustStamp };
const edited = (j: Job): Stamped => ({ ...j, stamp: editedStamp(KEY, j, LATER)! });

describe('an edit of a started job\'s item', () => {
  it('lowers the level to untrusted, by the edit, with its reason; the MAC covers it', () => {
    const j = edited(stamped(job('a', { source: github() })));
    expect(j.stamp).toMatchObject({ v: 1, level: 'untrusted', by: 'edit', at: LATER, reasons: ['origin:trusted', 'author:assignee', EDIT_REASON] });
    expect(verifiedLevel(KEY, j)).toBe('untrusted');
    expect(verifiedLevel(KEY, { ...j, stamp: { ...j.stamp, level: 'approved' as const } })).toBeUndefined();
  });

  it('keeps Jev\'s check on the stamp', () => {
    const base = stamped(job('a', { source: github() }));
    const checked = { ...base, stamp: signStamp(KEY, base, { ...base.stamp!, check: { pick: 'keep', confidence: 0.9, applied: true } }) };
    expect(edited(checked).stamp.check).toEqual({ pick: 'keep', confidence: 0.9, applied: true });
  });

  it('gives nothing for a job at untrusted already, a quarantined one, or a stamp that does not verify', () => {
    expect(editedStamp(KEY, stamped(job('a', { source: github({ origin: undefined }) })), LATER)).toBeUndefined();
    const j = stamped(job('b', { source: github() }));
    expect(editedStamp(KEY, { ...j, stamp: quarantinedStamp(KEY, j, LATER) }, LATER)).toBeUndefined();
    expect(editedStamp(KEY, { ...j, id: 'c' }, LATER)).toBeUndefined();
    expect(editedStamp(KEY, job('d', { source: github() }), LATER)).toBeUndefined();
  });

  it('a job it lowered that waits again says why; a person approves its trust, who signs approved', () => {
    const j = edited(stamped(job('a', { source: github() })));
    expect(stampHold(KEY, j)).toBe('trust stamp untrusted is below approved (its item was edited after it started): held — a person approves its trust on the job, or cancels it');
    expect(trustApprovable(KEY, j)).toBe(true);
    const approved = { ...j, stamp: trustApprovedStamp(KEY, j, LATER) };
    expect(approved.stamp).toMatchObject({ level: 'approved', by: 'person' });
    expect(trustApprovable(KEY, approved)).toBe(false);
    // A later edit lowers it again.
    expect(edited(approved).stamp.level).toBe('untrusted');
  });
});

describe('gate 2\'s automatic approvals', () => {
  it('need a stamp that verifies at approved or above', () => {
    const at = (level: TrustStamp['level']) => { const j = job('a', { source: github() }); return { ...j, stamp: signStamp(KEY, j, { level, reasons: [], by: 'intake', at: AT }) }; };
    expect(autoApprovable(KEY, at('owner'), STANDARD)).toBe(true);
    expect(autoApprovable(KEY, at('trusted'), STANDARD)).toBe(true);
    expect(autoApprovable(KEY, at('approved'), STANDARD)).toBe(true);
    expect(autoApprovable(KEY, at('screened'), STANDARD)).toBe(false);
    expect(autoApprovable(KEY, at('untrusted'), STANDARD)).toBe(false);
    expect(autoApprovable(KEY, at('quarantined'), STANDARD)).toBe(false);
    expect(autoApprovable(KEY, job('b', { source: github() }), STANDARD)).toBe(false);
    expect(autoApprovable(KEY, { ...at('owner'), id: 'c' }, STANDARD)).toBe(false);
  });
});
