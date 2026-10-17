// Issue #1471: a job whose named sandboxes are not approved and ready yet is held before it starts, with the reason the
// engine gives; the others start. A job resuming after a question was started already: it is never held for them.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job } from './support.ts';

const reason = 'awaiting its sandboxes: the sandbox runs of template cluster-role-builder wait for a person on Access requests';

describe('sandboxes before the start, in the decider (issue #1471)', () => {
  it('holds a job its sandboxes hold, with room to spare; the others start', () => {
    const d = decide(inputs({ waiting: [job('boxed'), job('plain')], sandboxesHeld: [{ jobId: 'boxed', reason }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'boxed', reason }]);
    expect(d.start.map((s) => s.jobId)).toEqual(['plain']);
  });

  it('a person\'s approval of a router hold does not start it: only its sandboxes\' approval does', () => {
    const d = decide(inputs({ waiting: [job('boxed', { approved: true })], sandboxesHeld: [{ jobId: 'boxed', reason }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'boxed', reason }]);
  });

  it('the queue gate comes first: an unaccepted job is held awaiting acceptance', () => {
    const d = decide(inputs({ waiting: [job('boxed', { accepted: false })], sandboxesHeld: [{ jobId: 'boxed', reason }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'boxed', reason: 'awaiting acceptance' }]);
  });

  it('a job resuming after a question is not held for them: it started already', () => {
    const d = decide(inputs({ waiting: [job('boxed', { pendingAnswer: 'yes' })], sandboxesHeld: [{ jobId: 'boxed', reason }] }), 'd1');
    expect(d.hold).toEqual([]);
  });
});
