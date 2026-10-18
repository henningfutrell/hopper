// The stamp view (issue #655, part 10): what the API and the CLI say of one job's trust stamp — the stamp as kept, with
// no MAC; whether it verifies; the brake on the job and whether the stamp holds its start; whether gate 2 approves its
// requests with no person; whether its proxy token opens the hopper's doors; and whether Jev's trust check is due. Pure.
import { describe, expect, it } from 'vitest';
import { brakeOf, DEFAULT_INTAKE_STRICTNESS } from '../../src/domain/intake-strictness.ts';
import { stampView } from '../../src/domain/stamp-view.ts';
import { quarantinedStamp, ruleCeiling, signStamp, STAMP_MISMATCH, STAMP_MISSING } from '../../src/domain/trust-stamp.ts';
import type { Job, JobSourceRef } from '../../src/domain/types.ts';
import { job } from '../decider/support.ts';

const KEY = Buffer.alloc(32, 7);
const AT = '2026-10-17T10:00:00.000Z';
const standard = brakeOf(DEFAULT_INTAKE_STRICTNESS, undefined);
const github = (over: Partial<JobSourceRef> = {}): JobSourceRef => ({
  source: 'github', kind: 'github-account', key: 'https://github.com/o/r/issues/1', repo: 'o/r', number: 1,
  author: 'ada', assignee: 'ada', origin: 'trusted', ...over,
});
const stamped = (j: Job): Job => ({ ...j, stamp: signStamp(KEY, j, { level: ruleCeiling(j).level, reasons: ruleCeiling(j).reasons, by: 'intake', at: AT }) });

describe('stampView', () => {
  it('a stamp that verifies: its level, no hold, gate 2 approves with no person, the doors open', () => {
    const j = stamped(job('a', { source: github() }));
    expect(stampView(KEY, j, standard)).toEqual({
      jobId: 'a',
      stamp: { level: 'owner', reasons: ['origin:trusted', 'author:assignee'], by: 'intake', at: AT },
      verifies: 'yes', level: 'owner',
      brake: { strictness: 'standard', needs: 'approved', at: 'default' },
      startHold: null, gate2: 'auto', doorsOpen: true, checkDue: false,
    });
  });

  it('a stamp below the brake: the hold says why; gate 2 asks a person (part 12); a check is due for an approved job', () => {
    const j = stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) }));
    const strict = brakeOf({ default: 'strict', sources: {}, repos: {} }, j.source);
    const v = stampView(KEY, j, strict);
    expect(v).toMatchObject({ verifies: 'yes', level: 'approved', brake: { strictness: 'strict', needs: 'trusted' }, gate2: 'person', doorsOpen: true, checkDue: true });
    expect(v.startHold).toMatch(/^trust stamp approved is below trusted \(intake strictness strict by default\)/);
  });

  it('a quarantined job: held, gate 2 asks a person, the doors closed; the level it had is kept', () => {
    const j = stamped(job('a', { source: github() }));
    const v = stampView(KEY, { ...j, stamp: quarantinedStamp(KEY, j, AT) }, standard);
    expect(v).toMatchObject({ verifies: 'yes', level: 'quarantined', stamp: { level: 'quarantined', was: 'owner' }, gate2: 'person', doorsOpen: false });
    expect(v.startHold).toMatch(/^quarantined by a person/);
  });

  it('no stamp, and a stamp that does not verify: no level, held, the doors closed', () => {
    expect(stampView(KEY, job('a'), standard)).toMatchObject({ stamp: null, verifies: 'missing', level: null, startHold: STAMP_MISSING, gate2: 'person', doorsOpen: false });
    const j = stamped(job('a', { source: github({ origin: 'approved', author: 'stranger' }) }));
    const raised = { ...j, stamp: { ...j.stamp!, level: 'owner' as const } };
    expect(stampView(KEY, raised, standard)).toMatchObject({ stamp: { level: 'owner' }, verifies: 'no', level: null, startHold: STAMP_MISMATCH, gate2: 'person', doorsOpen: false });
  });

  it('never shows the MAC', () => {
    expect(JSON.stringify(stampView(KEY, stamped(job('a', { source: github() })), standard))).not.toContain('mac');
  });

  it('with no stamp key the hopper cannot verify: unknown, and it holds nothing', () => {
    expect(stampView(undefined, stamped(job('a', { source: github() })), standard)).toMatchObject({
      verifies: 'unknown', level: null, startHold: null, gate2: 'auto', doorsOpen: true, checkDue: false,
    });
  });
});
