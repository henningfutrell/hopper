// Issue #159: a job not yet accepted at the queue gate never starts; the decider holds it.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job } from './support.ts';

describe('the queue gate in the decider', () => {
  it('holds an unaccepted job "awaiting acceptance", with room to spare; an accepted one starts', () => {
    const d = decide(inputs({ waiting: [job('new', { accepted: false }), job('ok', { accepted: true }), job('old')] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'new', reason: 'awaiting acceptance' }]);
    expect(d.start.map((s) => s.jobId).sort()).toEqual(['ok', 'old']);
  });

  it('an approval does not pass the gate: approving overrides router holds, not acceptance', () => {
    const d = decide(inputs({ waiting: [job('new', { accepted: false, approved: true })] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'new', reason: 'awaiting acceptance' }]);
  });
});
