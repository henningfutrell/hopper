// Which running jobs a restart would lose: a non-idempotent executor that cannot reattach.
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { restartBlockers } from '../../src/update/index.ts';

const exec = (name: string, o: Partial<Executor> = {}): Executor => ({ name, validate: () => null, run: async () => ({ kind: 'finished', result: null }), ...o }) as Executor;
const job = (id: string, executor: string): Job => ({ id, spec: { executor } }) as unknown as Job;

describe('restartBlockers', () => {
  it('names running jobs whose executor neither re-runs nor reattaches them', () => {
    const executors = new Map([
      ['rerun', exec('rerun', { idempotent: true })],
      ['reattach', exec('reattach', { idempotent: false, canReattach: async () => true, reattach: async () => ({ kind: 'finished', result: null }) })],
      ['fragile', exec('fragile', { idempotent: false })],
    ]);
    const jobs = [job('j1', 'rerun'), job('j2', 'reattach'), job('j3', 'fragile'), job('j4', 'gone')];
    expect(restartBlockers(jobs, (n) => executors.get(n))).toEqual(['job j3 (executor fragile)']);
  });
});
