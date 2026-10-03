import type { Clock, ExecutionContext } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient, createHerdrClaudeExecutor } from '../../src/executors/herdr/index.ts';
import type { FakeHerdrOptions } from '../../src/executors/herdr/index.ts';

export const JOB_ID = 'abcdef12-3456-7890-abcd-ef1234567890';
export const CWD = '/tmp/jh-work';
export const LANE = 'local/lane-1';

/** A clock that only moves when the executor sleeps; each sleep yields one macrotask. */
export function fakeClock(start = Date.parse('2026-10-02T12:00:00Z')) {
  let t = start;
  const clock: Clock & { elapsed(): number } = { now: () => new Date(t), elapsed: () => t - start };
  const sleep = async (ms: number): Promise<void> => {
    t += ms;
    await new Promise((r) => setImmediate(r));
  };
  return { clock, sleep };
}

export function jobWith(payload: Record<string, unknown>, extra: Partial<Job> = {}): Job {
  return {
    id: JOB_ID, spec: { executor: 'herdr-claude', payload }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1, ...extra,
  };
}

export function contextFor(job: Job, laneId = LANE) {
  const ac = new AbortController();
  const progress: { fraction: number; message?: string }[] = [];
  const saved: Record<string, unknown>[] = [];
  const ctx: ExecutionContext = {
    job, laneId, signal: ac.signal,
    progress: (fraction, message) => progress.push({ fraction, message }),
    saveState: (s) => saved.push(s),
  };
  return { ctx, ac, progress, saved };
}

export function setup(fakeOptions: FakeHerdrOptions = {}, overrides: { trustWorkdir?: boolean; idleQuestionMs?: number; claudeArgs?: string[] } = {}) {
  const herdr = createFakeHerdrClient({ session: 'jh-test', ...fakeOptions });
  const { clock, sleep } = fakeClock();
  const executor = createHerdrClaudeExecutor({
    herdr, clock, sleep, defaultCwd: CWD, claudeArgs: overrides.claudeArgs ?? ['--dangerously-skip-permissions'],
    trustWorkdir: overrides.trustWorkdir ?? true, pollMs: 1000, idleQuestionMs: overrides.idleQuestionMs ?? 20000,
  });
  return { herdr, clock, executor };
}

/** Yield macrotasks until cond holds (the executor loop advances one poll per yield). */
export async function until(cond: () => boolean, max = 2000): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error('condition never held');
}
