// Trust stamps in the decider (issue #655, part 1): a job whose stamp is missing, does not match it, or is below the
// dispatch minimum is held with the engine's reason, before the queue gate and every other judgement but its origin.
import { describe, expect, it } from 'vitest';
import { decide, ORIGIN_PENDING } from '../../src/decider/index.ts';
import { STAMP_MISSING } from '../../src/domain/trust-stamp.ts';
import { inputs, job } from './support.ts';

describe('trust stamps in the decider (issue #655)', () => {
  it('holds a job its stamp holds; the others start', () => {
    const d = decide(inputs({ waiting: [job('bad'), job('good')], stampHeld: [{ jobId: 'bad', reason: STAMP_MISSING }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'bad', reason: STAMP_MISSING }]);
    expect(d.start.map((s) => s.jobId)).toEqual(['good']);
  });

  it('comes before the queue gate and a person\'s approval', () => {
    const d = decide(inputs({ waiting: [job('bad', { accepted: false, approved: true })], stampHeld: [{ jobId: 'bad', reason: STAMP_MISSING }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'bad', reason: STAMP_MISSING }]);
  });

  it('holds a job resuming after a question too', () => {
    const d = decide(inputs({ waiting: [job('bad', { pendingAnswer: 'yes' })], stampHeld: [{ jobId: 'bad', reason: STAMP_MISSING }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'bad', reason: STAMP_MISSING }]);
  });

  it('a job whose origin is pending is held for its origin first', () => {
    const d = decide(inputs({ waiting: [job('old', { originPending: true })], stampHeld: [{ jobId: 'old', reason: STAMP_MISSING }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'old', reason: ORIGIN_PENDING }]);
  });
});
