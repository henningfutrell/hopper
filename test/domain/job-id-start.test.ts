// Issue #1780: the views show a job by the first 8 characters of its id (its short id), so `hopper job show` takes one.
import { describe, expect, it } from 'vitest';
import { jobIdStarting } from '../../src/domain/job-id-start.ts';

const IDS = ['37434b2d-1111-4000-8000-000000000000', '37434b2d-2222-4000-8000-000000000000', '547e0f25-3333-4000-8000-000000000000'];

describe('a job by the start of its id (issue #1780)', () => {
  it('names the one job whose id starts so', () => {
    expect(jobIdStarting(IDS, '547e0f25')).toEqual({ id: IDS[2] });
    expect(jobIdStarting(IDS, '37434b2d-2')).toEqual({ id: IDS[1] });
  });

  it('says how many jobs start so when more than one does', () => {
    expect(jobIdStarting(IDS, '37434b2d')).toEqual({ ambiguous: 2 });
  });

  it('names none when no id starts so, or the start is shorter than a short id, or not an id\'s', () => {
    expect(jobIdStarting(IDS, 'ffffffff')).toEqual({});
    expect(jobIdStarting(IDS, '547e0f2')).toEqual({});
    expect(jobIdStarting(IDS, '547e0f25%')).toEqual({});
  });
});
