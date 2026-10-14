// The hopper's own disk use on a machine (issue #1120, design.md "Hopper's own disk use" → "Part 2"): what the sweep's
// survey measured of the places the hopper keeps things in each work tree — its scratch area and its job worktrees —,
// held against the disk budget, the most the user lets it be on one machine. Pure.

/** One place the hopper keeps things on a machine, as the survey measured it: a work tree's scratch area or its job worktrees. */
export interface HopperDiskPath { path: string; bytes: number }

/**
 * The hopper's own disk use on one machine, as the sweep last measured it (issue #1120): the bytes of each place, their
 * sum, and when. `budgetBytes`: the disk budget now, absent when there is none; `over`: the use is more than it.
 */
export interface HopperDisk { bytes: number; at: string; paths: HopperDiskPath[]; budgetBytes?: number; over: boolean }

/** The disk budget (issue #1120): the most the hopper's own disk use may be on each machine. The user's setting, an admin's to change. */
export interface DiskBudget { bytes: number }

/** The hopper's disk use from what a survey measured, at `at`, against `budget`; undefined when it measured nothing. */
export function hopperDiskOf(paths: readonly HopperDiskPath[] | undefined, at: string, budget: DiskBudget | undefined): HopperDisk | undefined {
  if (!paths || paths.length === 0) return undefined;
  const bytes = paths.reduce((sum, p) => sum + p.bytes, 0);
  return { bytes, at, paths: [...paths], ...(budget ? { budgetBytes: budget.bytes } : {}), over: budget !== undefined && bytes > budget.bytes };
}
