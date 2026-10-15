// The latency budget of a person's actions (issue #1194). The target is 200 ms, and a test holds a run on a developer's
// machine to it. A CI runner is shared and slower: there the bound is 1000 ms, still half of `SLOW_MS`, so an action that
// waits for a slowed seam fails there too. `HOPPER_TEST_LATENCY_BUDGET_MS` sets the bound for one run.

/** What the slowed seams (GitHub, the job's machine) take for each call. */
export const SLOW_MS = 2000;

/** What an action may take to answer. Anything that waits for the slow side takes `SLOW_MS` at least. */
export const BUDGET_MS = budget(process.env);

export function budget(env: NodeJS.ProcessEnv): number {
  const set = Number(env.HOPPER_TEST_LATENCY_BUDGET_MS);
  if (Number.isFinite(set) && set > 0) return Math.min(set, SLOW_MS / 2);
  return env.CI ? SLOW_MS / 2 : 200;
}
