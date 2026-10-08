// Issue #371: an ended job of an item whose cleanup has not gone through may still run in its pane, so a
// waiting job of the same item is held until it does, never started beside it.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Job } from '../../src/domain/types.ts';
import { advice, inputs, job } from './support.ts';

const of = (id: string, key: string): Job => job(id, { advice: advice('proceed_full'), source: { source: 'github', kind: 'github', key } });

describe('a waiting job whose item has a cleanup due', () => {
  it('is held while that cleanup is deferred, with the job and the error', () => {
    const d = decide(inputs({ waiting: [of('new', 'k1')], cleanupDue: [{ jobId: 'old', sourceKey: 'k1', error: 'herdr: not dialled in' }] }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'new', reason: 'job old of this item may still run: its cleanup waits for its machine (herdr: not dialled in)' }]);
  });

  it('is held while that cleanup still runs', () => {
    const d = decide(inputs({ waiting: [of('new', 'k1')], cleanupDue: [{ jobId: 'old', sourceKey: 'k1' }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'new', reason: 'job old of this item is being cleaned up' }]);
  });

  it('starts when the cleanup due is for another item, or for itself', () => {
    const d = decide(inputs({ waiting: [of('new', 'k1')], cleanupDue: [{ jobId: 'x', sourceKey: 'k2', error: 'e' }, { jobId: 'new', sourceKey: 'k1', error: 'e' }] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['new']);
    expect(d.hold).toEqual([]);
  });

  it('a Decision recorded before the input starts as before', () => {
    const d = decide(inputs({ waiting: [of('new', 'k1')] }), 'd1');
    expect(d.start.map((s) => s.jobId)).toEqual(['new']);
  });
});
