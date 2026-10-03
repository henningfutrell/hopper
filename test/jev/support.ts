import type { Clock } from '../../src/domain/ports.ts';
import type { Job, JobSpec } from '../../src/domain/types.ts';

export const fixedClock: Clock = { now: () => new Date('2026-10-02T12:00:00.000Z') };

export function makeJob(spec: Partial<JobSpec> = {}): Job {
  return {
    id: 'job-1',
    spec: { executor: 'noop', payload: {}, ...spec },
    priority: 50,
    status: 'queued',
    approved: false,
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:00:00.000Z',
    attempts: 0,
  };
}
