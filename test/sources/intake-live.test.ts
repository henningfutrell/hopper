// A source status as it is now (issue #798): a taken item names its job and that job's status now. So does a blocked item
// (issue #1891), so Intake offers Run again on its job beside Won't do.
import { describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { liveIntake } from '../../src/sources/intake-live.ts';

const status = (intake: IntakeOutcome[]): SourceStatus => ({ name: 'github', detail: { intake } } as unknown as SourceStatus);
const job = { id: 'job-1', status: 'finished' } as Job;

describe('liveIntake', () => {
  it('names the job of a taken item and of a blocked item, not of another item kept out', () => {
    const out = liveIntake(status([
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B', reason: 'blocked', action: 'wont_do' },
      { key: 'c', title: 'C', reason: 'on the backburner', action: 'unbackburner' },
    ]), () => job).detail?.intake as IntakeOutcome[];
    expect(out.map((x) => x.jobId)).toEqual(['job-1', 'job-1', undefined]);
    expect(out[1]?.jobStatus).toBe('finished');
  });
});
