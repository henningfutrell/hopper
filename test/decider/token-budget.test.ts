// Issue #2302, part 5: a day budget is an input of admission. A waiting job the engine names in `budgetHeld` — its day's
// token or cost budget, or its repository's, is reached — is held with the engine's reason, new or resuming; the others start.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job } from './support.ts';

const reason = 'Held by the token budget: the jobs of owner/a used its day\'s token budget of 1,000 tokens on 2026-10-21 (UTC). No job of owner/a starts or goes on until the next UTC day, or until an admin raises the budget.';

describe('the day budgets in the decider (issue #2302, part 5)', () => {
  it('holds a job its day budget holds, with room to spare; the others start', () => {
    const d = decide(inputs({ waiting: [job('spent'), job('other')], budgetHeld: [{ jobId: 'spent', reason }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'spent', reason }]);
    expect(d.start.map((s) => s.jobId)).toEqual(['other']);
  });

  it('holds a job resuming after a question too: the budget counts what goes on as well as what starts', () => {
    const d = decide(inputs({ waiting: [job('spent', { pendingAnswer: 'yes' })], budgetHeld: [{ jobId: 'spent', reason }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'spent', reason }]);
    expect(d.start).toEqual([]);
  });

  it('the queue gate comes first: an unaccepted job is held awaiting acceptance', () => {
    const d = decide(inputs({ waiting: [job('spent', { accepted: false })], budgetHeld: [{ jobId: 'spent', reason }] }), 'd1');
    expect(d.hold).toEqual([{ jobId: 'spent', reason: 'awaiting acceptance' }]);
  });
});
