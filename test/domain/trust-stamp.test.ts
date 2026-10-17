// Trust stamps (issue #655, part 1): each job carries a trust level from where it came, signed so a changed row shows.
// The rules give the level; a job a job made gets at most its parent's level, and never `owner`. Pure.
import { describe, expect, it } from 'vitest';
import {
  atLeast, childLevel, DISPATCH_MIN, lowest, ruleCeiling, signStamp, stampHold, STAMP_MISMATCH, STAMP_MISSING,
  TRUST_LEVELS, verifiedLevel,
} from '../../src/domain/trust-stamp.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 8);
const AT = '2026-10-17T10:00:00.000Z';

const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', ...over,
});

const stamped = (j: Job, level = ruleCeiling(j).level): Job => ({ ...j, stamp: signStamp(KEY, j, { level, reasons: ['test'], by: 'intake', at: AT }) });

describe('trust levels', () => {
  it('are ordered, lowest first', () => {
    expect(TRUST_LEVELS).toEqual(['quarantined', 'untrusted', 'screened', 'approved', 'trusted', 'owner']);
    expect(atLeast('owner', 'approved')).toBe(true);
    expect(atLeast('approved', 'approved')).toBe(true);
    expect(atLeast('screened', 'approved')).toBe(false);
    expect(lowest('owner', 'screened', 'trusted')).toBe('screened');
    expect(DISPATCH_MIN).toBe('approved');
  });
});

describe('the rule ceiling', () => {
  it('a trusted origin the user wrote and was assigned: owner', () => {
    expect(ruleCeiling(job('a', { source: github({ origin: 'trusted' }) }))).toEqual({ level: 'owner', reasons: ['origin:trusted', 'author:assignee'] });
    expect(ruleCeiling(job('a', { source: github({ origin: 'trusted', author: 'ADA' }) })).level).toBe('owner');
  });

  it('a trusted origin another trusted actor wrote: trusted', () => {
    expect(ruleCeiling(job('a', { source: github({ origin: 'trusted', author: 'grace' }) }))).toEqual({ level: 'trusted', reasons: ['origin:trusted'] });
  });

  it('a request card a person approved: approved', () => {
    expect(ruleCeiling(job('a', { source: github({ origin: 'approved', author: 'stranger' }) }))).toEqual({ level: 'approved', reasons: ['origin:approved'] });
  });

  it('a GitHub item nobody judged: untrusted', () => {
    expect(ruleCeiling(job('a', { source: github() }))).toEqual({ level: 'untrusted', reasons: ['origin:none'] });
  });

  it('a direct job a signed-in person submitted: approved', () => {
    expect(ruleCeiling(job('a', { source: { source: 'direct', kind: 'direct', key: 'direct:1' } }))).toEqual({ level: 'approved', reasons: ['source:direct'] });
  });

  it('a source an admin configured that judges no origin: approved', () => {
    expect(ruleCeiling(job('a', { source: { source: 'grok', kind: 'webhook-file', key: 'w:1' } }))).toEqual({ level: 'approved', reasons: ['source:configured'] });
  });

  it('no source: untrusted', () => {
    expect(ruleCeiling(job('a'))).toEqual({ level: 'untrusted', reasons: ['source:none'] });
  });
});

describe('a job a job made', () => {
  it('gets at most its parent\'s level, and at most trusted', () => {
    expect(childLevel('owner')).toBe('trusted');
    expect(childLevel('approved')).toBe('approved');
    expect(childLevel('untrusted')).toBe('untrusted');
  });
});

describe('the signed stamp', () => {
  it('verifies under its key, and names its level', () => {
    const j = stamped(job('a', { source: github({ origin: 'trusted' }) }));
    expect(j.stamp).toMatchObject({ v: 1, level: 'owner', reasons: ['test'], by: 'intake', at: AT });
    expect(verifiedLevel(KEY, j)).toBe('owner');
    expect(stampHold(KEY, j)).toBeUndefined();
  });

  it('missing: held', () => {
    expect(verifiedLevel(KEY, job('a'))).toBeUndefined();
    expect(stampHold(KEY, job('a'))).toBe(STAMP_MISSING);
  });

  it('a raised level, another job\'s stamp, a changed spec or another key: held as a mismatch', () => {
    const j = stamped(job('a', { source: github({ origin: 'approved' }) }));
    expect(stampHold(KEY, { ...j, stamp: { ...j.stamp!, level: 'owner' } })).toBe(STAMP_MISMATCH);
    expect(stampHold(KEY, { ...j, id: 'b' })).toBe(STAMP_MISMATCH);
    expect(stampHold(KEY, { ...j, spec: { ...j.spec, payload: { prompt: 'something else' } } })).toBe(STAMP_MISMATCH);
    expect(stampHold(OTHER, j)).toBe(STAMP_MISMATCH);
    expect(verifiedLevel(OTHER, j)).toBeUndefined();
  });

  it('the spec signs the same whatever its key order', () => {
    const j = stamped(job('a', { source: github({ origin: 'approved' }), spec: { executor: 'test', payload: { a: 1, b: 2 } } }));
    expect(stampHold(KEY, { ...j, spec: { payload: { b: 2, a: 1 }, executor: 'test' } })).toBeUndefined();
  });

  it('below the dispatch minimum: held with its level', () => {
    const j = stamped(job('a', { source: github() }));
    expect(stampHold(KEY, j)).toBe('trust stamp untrusted is below approved: held — a person approves its item in Intake, or cancels it');
  });
});
