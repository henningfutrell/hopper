// Intake strictness (issue #655 part 3, brake 1): the level a job's stamp needs before it starts, per source and per
// repository; the most specific wins. Pure.
import { describe, expect, it } from 'vitest';
import { brakeOf, brakeWhere, DEFAULT_INTAKE_STRICTNESS, STRICTNESS_MIN, type IntakeStrictness } from '../../src/domain/intake-strictness.ts';
import { signStamp, stampHold } from '../../src/domain/trust-stamp.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const src = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({ source: 'github', kind: 'github-account', key: 'k', repo: 'O/R', ...over });
const stamped = (j: Job, level: 'owner' | 'trusted' | 'approved' | 'screened' | 'untrusted'): Job =>
  ({ ...j, stamp: signStamp(KEY, j, { level, reasons: ['test'], by: 'intake', at: AT }) });

describe('the brake', () => {
  it('each strictness needs its level', () => {
    expect(STRICTNESS_MIN).toEqual({ open: 'screened', standard: 'approved', strict: 'trusted', closed: 'owner' });
  });

  it('standard by default: approved, the dispatch minimum before brakes', () => {
    expect(brakeOf(DEFAULT_INTAKE_STRICTNESS, src())).toEqual({ min: 'approved', strictness: 'standard', at: 'default' });
    expect(brakeOf(DEFAULT_INTAKE_STRICTNESS, undefined)).toEqual({ min: 'approved', strictness: 'standard', at: 'default' });
  });

  it('the repository, else the source, else the default', () => {
    const s: IntakeStrictness = { default: 'strict', sources: { github: 'open', other: 'closed' }, repos: { 'o/r': 'closed' } };
    expect(brakeOf(s, src())).toEqual({ min: 'owner', strictness: 'closed', at: { repo: 'o/r' } });
    expect(brakeOf(s, src({ repo: 'o/x' }))).toEqual({ min: 'screened', strictness: 'open', at: { source: 'github' } });
    expect(brakeOf(s, src({ source: 'direct', kind: 'direct', repo: undefined }))).toEqual({ min: 'trusted', strictness: 'strict', at: 'default' });
    expect(brakeWhere(brakeOf(s, src()))).toBe('for o/r');
    expect(brakeWhere(brakeOf(s, src({ repo: 'o/x' })))).toBe('for the source github');
    expect(brakeWhere(brakeOf(s, undefined))).toBe('by default');
  });
});

describe('the stamp check under a brake', () => {
  const strict: IntakeStrictness = { default: 'standard', sources: {}, repos: { 'o/r': 'strict' } };

  it('a level the brake lets through: no hold', () => {
    const j = stamped(job('a', { source: src() }), 'trusted');
    expect(stampHold(KEY, j, brakeOf(strict, j.source))).toBeUndefined();
  });

  it('approved, under strict: held, and the hold names the brake', () => {
    const j = stamped(job('a', { source: src() }), 'approved');
    expect(stampHold(KEY, j)).toBeUndefined();
    expect(stampHold(KEY, j, brakeOf(strict, j.source))).toBe(
      'trust stamp approved is below trusted (intake strictness strict for o/r): held — an admin changes the intake strictness in Settings → Intake, or a person cancels it',
    );
  });

  it('under approved: held as before, whatever the brake', () => {
    const j = stamped(job('a', { source: src() }), 'untrusted');
    expect(stampHold(KEY, j, brakeOf(strict, j.source))).toBe('trust stamp untrusted is below trusted: held — a person approves its item in Intake, or cancels it');
  });

  it('open lets a screened job run', () => {
    const j = stamped(job('a', { source: src() }), 'screened');
    expect(stampHold(KEY, j, brakeOf({ ...DEFAULT_INTAKE_STRICTNESS, default: 'open' }, j.source))).toBeUndefined();
    expect(stampHold(KEY, j, brakeOf(DEFAULT_INTAKE_STRICTNESS, j.source))).toBe('trust stamp screened is below approved: held — a person approves its item in Intake, or cancels it');
  });
});
