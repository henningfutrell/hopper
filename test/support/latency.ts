// The latency budget of a person's actions (issue #1194). CI asserts only the order: with GitHub held (its calls never
// end until the test releases them, `slow-github.ts`), each action answers, and its GitHub work is recorded after. A
// clock on a shared CI runner is not reliable, so the time of an answer is asserted only on a developer's machine — off
// CI, or with `HOPPER_PERF=1` —, against the 200 ms target. `HOPPER_TEST_LATENCY_BUDGET_MS` sets the bound for one run.
import { expect } from 'vitest';

/** What a slowed seam (the job's machine) takes for each call. */
export const SLOW_MS = 2000;

/** The target for an answer, in ms. */
export const BUDGET_MS = budget(process.env);

/** Whether this run asserts the time of an answer. */
export const PERF = perf(process.env);

export function budget(env: NodeJS.ProcessEnv): number {
  const set = Number(env.HOPPER_TEST_LATENCY_BUDGET_MS);
  return Number.isFinite(set) && set > 0 ? Math.min(set, SLOW_MS / 2) : 200;
}

export function perf(env: NodeJS.ProcessEnv): boolean {
  return env.HOPPER_PERF === '1' || !env.CI;
}

/** The answer took less than `bound` ms: asserted only when this run asserts times (`PERF`). */
export function withinBudget(ms: number, bound = BUDGET_MS): void {
  if (PERF) expect(ms, `answered in ${Math.round(ms)} ms`).toBeLessThan(bound);
}
