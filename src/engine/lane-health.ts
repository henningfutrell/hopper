// Lane health (issue #2234, design.md "Unhealthy lanes"): a lane whose every start failed the same way kept taking jobs,
// each failing after minutes, and the failure assessor's rerun of each went to the same lane again. So a lane whose last
// LANE_START_FAILURES starts failed with the same start error — its lane's fault (src/reliability/fault.ts), the same start
// of its normalised text (src/failures/signature.ts; the pane's screen after it differs from job to job) — is unhealthy:
// its machine carries it (`unhealthyLanes`), and the decider places no new job on it (src/decider/lane-health.ts) until
// LANE_OUT_MS passed. Then one job is placed there; a start that fails
// the same way puts it out again at once, one that gets under way makes it healthy. A rerun of a job that failed for its
// lane's fault goes to another lane when it can (`avoidLanesOf`). Kept in memory, as reach holds are: a restart forgets it.
import type { Clock, MachineSource } from '../domain/ports.ts';
import type { UnhealthyLane } from '../domain/machines.ts';
import type { Job, JobId, LaneId } from '../domain/types.ts';
import { normalise } from '../failures/signature.ts';
import { isLaneFault } from '../reliability/fault.ts';

/** How many starts in a row on one lane fail with the same start error before it is unhealthy. */
export const LANE_START_FAILURES = 3;
/** How long an unhealthy lane takes no new job, before one is placed there to try it again. */
export const LANE_OUT_MS = 30 * 60_000;

export interface LaneHealth {
  /**
   * A job's run on `laneId` ended: `error` its failure, undefined when it got under way or ended otherwise. The lane when
   * this start put it out, else undefined.
   */
  ended(laneId: LaneId, error: string | undefined): UnhealthyLane | undefined;
  /** The machines, each one carrying its lanes that are out now. */
  source(machines: MachineSource): MachineSource;
}

/** How much of a start error's normalised text says what failed: the pane's screen it ends with differs from job to job. */
const KIND_CHARS = 120;

/** `${machineId}/lane-${n}`: the machine's part. */
const machineOfLane = (laneId: LaneId): string => laneId.slice(0, laneId.lastIndexOf('/lane-'));

export function createLaneHealth(clock: Clock, outMs = LANE_OUT_MS): LaneHealth {
  const streaks = new Map<LaneId, { kind: string; failures: number; since: string; out?: UnhealthyLane }>();
  const outNow = (machineId: string): UnhealthyLane[] => {
    const now = clock.now().getTime();
    return [...streaks.values()].flatMap((s) => (s.out && machineOfLane(s.out.laneId) === machineId && Date.parse(s.out.until) > now ? [s.out] : []));
  };
  return {
    ended(laneId, error) {
      if (error === undefined || !isLaneFault(error)) { streaks.delete(laneId); return undefined; }
      const kind = normalise(error).slice(0, KIND_CHARS);
      const at = clock.now();
      const was = streaks.get(laneId);
      const streak = was?.kind === kind ? { ...was, failures: was.failures + 1 } : { kind, failures: 1, since: at.toISOString() };
      if (streak.failures >= LANE_START_FAILURES) {
        streak.out = { laneId, failures: streak.failures, error, since: streak.since, until: new Date(at.getTime() + outMs).toISOString() };
      }
      streaks.set(laneId, streak);
      return streak.out;
    },
    source: (machines) => ({
      list: async () => (await machines.list()).map((m) => {
        const out = outNow(m.id);
        return out.length ? { ...m, unhealthyLanes: [...(m.unhealthyLanes ?? []), ...out] } : m;
      }),
    }),
  };
}

/**
 * For each waiting rerun of a job that failed for its lane's fault, that lane (issue #2234): the decider places it on
 * another lane when it can. Undefined when there is none.
 */
export function avoidLanesOf(waiting: readonly Job[], jobOf: (id: JobId) => Job | undefined): Record<JobId, LaneId> | undefined {
  const avoid: Record<JobId, LaneId> = {};
  for (const j of waiting) {
    const was = j.rerunOf === undefined ? undefined : jobOf(j.rerunOf);
    if (was?.status === 'failed' && was.laneId && was.error && isLaneFault(was.error)) avoid[j.id] = was.laneId;
  }
  return Object.keys(avoid).length ? avoid : undefined;
}
