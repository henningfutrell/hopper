// A tightened intake strictness re-checks started jobs at gate 2 (issue #655, part 12): brake 1 holds only a start, so a
// running job keeps its doors; but gate 2 approves its privileged requests with no person only while its stamp is at the
// level the brake on it needs, and at `approved` or above. Pure.
import { describe, expect, it } from 'vitest';
import { brakeOf, DEFAULT_INTAKE_STRICTNESS, type IntakeStrictness } from '../../src/domain/intake-strictness.ts';
import { autoApprovable, gate2Hold, gate2Min, signStamp, type TrustStamp } from '../../src/domain/trust-stamp.ts';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const source: JobSourceRef = { source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1 };
const at = (level: TrustStamp['level']) => { const j = job('a', { source }); return { ...j, stamp: signStamp(KEY, j, { level, reasons: [], by: 'intake', at: AT }) }; };
const brake = (s: Partial<IntakeStrictness>) => brakeOf({ ...DEFAULT_INTAKE_STRICTNESS, ...s }, source);

describe('gate 2 under brake 1', () => {
  it('needs the higher of approved and the level the brake needs', () => {
    expect(gate2Min(brake({}))).toBe('approved');
    expect(gate2Min(brake({ default: 'open' }))).toBe('approved');
    expect(gate2Min(brake({ default: 'strict' }))).toBe('trusted');
    expect(gate2Min(brake({ repos: { 'o/r': 'closed' } }))).toBe('owner');
  });

  it('approves with no person only at that level or above', () => {
    const strict = brake({ sources: { github: 'strict' } });
    expect(autoApprovable(KEY, at('owner'), strict)).toBe(true);
    expect(autoApprovable(KEY, at('trusted'), strict)).toBe(true);
    expect(autoApprovable(KEY, at('approved'), strict)).toBe(false);
    expect(autoApprovable(KEY, at('approved'), brake({}))).toBe(true);
    expect(autoApprovable(KEY, at('screened'), brake({ default: 'open' }))).toBe(false);
    expect(autoApprovable(KEY, at('trusted'), brake({ repos: { 'o/r': 'closed' } }))).toBe(false);
  });

  it('says why it asks a person: the brake, or the level below approved', () => {
    expect(gate2Hold(KEY, at('owner'), brake({ default: 'strict' }))).toBeUndefined();
    expect(gate2Hold(KEY, at('approved'), brake({ sources: { github: 'strict' } })))
      .toBe('its trust stamp approved is below trusted (intake strictness strict for the source github)');
    expect(gate2Hold(KEY, at('untrusted'), brake({}))).toBe('its trust stamp untrusted is below approved');
    expect(gate2Hold(KEY, job('b', { source }), brake({}))).toBe('its trust stamp does not verify');
  });
});
