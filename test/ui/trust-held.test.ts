// Issue #655: the Intake view of the stamp — which waiting jobs their trust stamp holds, and why, in the UI's pure model
// (ui/src/model/trust.ts). The UI imports nothing of src/ at run time, so it keeps the holds' starts: this test checks them
// against the daemon's texts.
import { describe, expect, it } from 'vitest';
import { CHECK_PENDING, QUARANTINED_HOLD, STAMP_MISMATCH, STAMP_MISSING, stampHold } from '../../src/domain/trust-stamp.ts';
import { ORIGIN_PENDING } from '../../src/decider/index.ts';
import { GATE_HOLD } from '../../src/domain/blast-radius.ts';
import { heldByTrust, trustHold } from '../../ui/src/model/trust.ts';
import type { Job } from '../../ui/src/model/wire.ts';

const held = (holdReason: string, id = 'h1') => ({ id, status: 'held', holdReason }) as unknown as Job;
const below = 'trust stamp untrusted is below approved (Jev\'s trust check: it changes CI, workflow files or branch rules): held — a person approves its trust on the job, or cancels it';
const brake = 'trust stamp approved is below trusted (intake strictness strict for octo/tools): held — an admin changes the intake strictness in Settings → Intake, or a person cancels it';

describe('the jobs a trust stamp holds', () => {
  it('names each kind of trust hold the daemon gives', () => {
    expect(trustHold(held(STAMP_MISSING))).toBe('missing');
    expect(trustHold(held(STAMP_MISMATCH))).toBe('mismatch');
    expect(trustHold(held(QUARANTINED_HOLD))).toBe('quarantined');
    expect(trustHold(held(CHECK_PENDING))).toBe('checking');
    expect(trustHold(held(below))).toBe('below');
    expect(trustHold(held(brake))).toBe('brake');
  });

  it('reads the daemon\'s own text for a level below the dispatch minimum', () => {
    const key = Buffer.alloc(32, 1);
    const job = { id: 'j', spec: { executor: 'x', payload: {} }, stamp: { v: 1, level: 'untrusted', reasons: ['origin:none'], by: 'intake', at: 'a', mac: 'bad' } } as never;
    // A stamp whose MAC does not verify is a mismatch, as the daemon says.
    expect(trustHold(held(stampHold(key, job)!))).toBe('mismatch');
  });

  it('is no trust hold for another hold, or for a job that is not held', () => {
    expect(trustHold(held(ORIGIN_PENDING))).toBeUndefined();
    expect(trustHold(held(`${GATE_HOLD}: desk is rated high`))).toBeUndefined();
    expect(trustHold({ id: 'q', status: 'queued', holdReason: STAMP_MISSING } as unknown as Job)).toBeUndefined();
  });

  it('lists the held jobs, those a person can act on first, and counts only them', () => {
    const jobs = [held(CHECK_PENDING, 'c'), held(QUARANTINED_HOLD, 'q'), held(ORIGIN_PENDING, 'o'), held(below, 'b')];
    const h = heldByTrust(jobs);
    expect(h.map((x) => x.job.id)).toEqual(['q', 'b', 'c']);
    expect(h.filter((x) => x.forPerson).map((x) => x.job.id)).toEqual(['q', 'b']);
  });
});
