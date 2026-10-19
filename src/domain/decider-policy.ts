// The decider's policy: the settings it decides by, carried verbatim in every Decision's inputs. Re-exported by types.ts.
import type { UsagePacing } from './usage.ts';

/** The soft lanes when none are set (issue #2091). */
export const DEFAULT_SOFT_LANES = 1;

export interface DeciderPolicy {
  /** Fraction of a budget used at which a machine's lane cap drops to `softLanes` (0..1). */
  softLimit: number;
  /** The soft lanes (issue #2091): the lanes a machine keeps from the soft limit to the hard limit, at most its maxLanes. Absent: 1. */
  softLanes?: number;
  /** Fraction used at which every idle lane closes and no job starts (0..1). */
  hardLimit: number;
  /** Priority added for cheap advice (chat_only, run_deterministic). */
  routerCheapBoost: number;
  /** An idle lane with no work for it closes only after being idle this long (ms). */
  laneIdleGraceMs: number;
  /** Priority added to a job resuming with an answer — it is part done. */
  resumeBoost: number;
  /** Usage pacing (issue #373). Absent on Decisions stored before it: all of it off. */
  pacing?: UsagePacing;
}
