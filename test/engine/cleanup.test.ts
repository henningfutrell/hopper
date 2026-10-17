// A job's cleanup is scheduled with setImmediate after the tx that ended it (a question dismissed or expired, a review
// ended): a stop, and the store's close after it, can come first (issue #828). Then the cleanup's read of the job threw
// "postgres: this database is closed" as an unhandled rejection, and the test run failed with all tests passed.
import { afterEach, describe, expect, it } from 'vitest';
import { createAnswerHandlers } from '../../src/engine/answers.ts';
import { createCleanups } from '../../src/engine/cleanup.ts';
import type { Question } from '../../src/domain/types.ts';

const unhandled: unknown[] = [];
const record = (e: unknown): void => { unhandled.push(e); };
afterEach(() => { process.off('unhandledRejection', record); unhandled.length = 0; });

describe('a job\'s cleanup', () => {
  it('reads nothing of the store once the hopper stops: a stop and the store\'s close can come before it runs', async () => {
    process.on('unhandledRejection', record);
    let stopping = false, closed = false;
    const readsAfterClose: string[] = [];
    let job = { id: 'j', status: 'waiting_answer', questionId: 'q', spec: { executor: 'agent' } };
    const store = {
      jobs: {
        list: () => [],
        get: (id: string) => {
          if (closed) { readsAfterClose.push(id); throw new Error('postgres: this database is closed'); }
          return job;
        },
        update: (_id: string, patch: object) => { job = { ...job, ...patch }; return job; },
      },
      events: { append: () => {} },
    };
    const c = {
      store, clock: { now: () => new Date('2026-10-16T00:00:00Z') }, keepPanes: false, stopping: () => stopping, trigger: () => {},
      executors: { get: () => ({ cleanup: async () => ({ kept: [] }) }) },
    };
    const handlers = createAnswerHandlers(c as never, createCleanups(c as never).run);

    handlers.onDismissed({ id: 'q', jobId: 'j' } as Question);
    // The app stops, and closes the store, before the scheduled cleanup runs.
    stopping = true; closed = true;
    await new Promise((r) => setTimeout(r, 20));

    expect(job.status).toBe('cancelled');
    expect(readsAfterClose).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
