// Preemption (issue #1525, design.md "Preemption"), step 7b: a job left waiting for a lane whose own priority is strictly
// higher than a running job's, on a machine where it would fit once that job's lane is free, preempts it. Of those, the
// lowest priority goes first, then the one started last (it loses the least work), then the lowest id. Each waiting job
// preempts one job at most, and each running job is preempted once. Never a job that has run less than the minimum run
// time since it started or resumed, one whose executor cannot park, one with no agent session to resume, one whose lane
// drains, or one a preemption already in flight names. Pure: the clock is `at`.
import { PREEMPT_IN_FLIGHT_MS, type Job, type Lane, type LaneId, type PreemptPlan, type PreemptionInput, type PriorityLanesInput, type WaitPlan } from '../domain/types.ts';
import { fitsLane, pinOf, type Candidate, type MachineState, type MachineStateWithCredentialHold } from './assign.ts';

const MINUTE_MS = 60_000;

/** A preemption a Decision made whose park has not gone through yet: its job runs still, and is not taken again. */
const inFlight = (j: Job, at: number): boolean => j.preempted !== undefined && at - new Date(j.preempted.at).getTime() < PREEMPT_IN_FLIGHT_MS;

/**
 * Issue #1525: whether `job` fits on the machine once `lane`, busy with `holder`, is free. Read after step 7 on the
 * states it counted: the lane is taken out of every count, the fit judged, and the counts put back.
 */
function fitsWhenFreed(s: MachineState, job: Job, lane: Lane, holder: Job, pl?: PriorityLanesInput): boolean {
  const c = s as MachineStateWithCredentialHold;
  const e = c.executors.get(holder.spec.executor);
  const unpinned = pinOf(holder) !== c.machine.id;
  const at = e?.occupied.indexOf(lane.id) ?? -1;
  const inUse = c.slots.inUse.delete(lane.id);
  c.occupied -= 1;
  if (unpinned) c.unpinned -= 1;
  if (at >= 0) e!.occupied.splice(at, 1);
  try {
    return fitsLane(c, job, pl);
  } finally {
    c.occupied += 1;
    if (unpinned) c.unpinned += 1;
    if (at >= 0) e!.occupied.splice(at, 0, lane.id);
    if (inUse) c.slots.inUse.add(lane.id);
  }
}

export function preempt(
  ordered: readonly Candidate[], waits: readonly WaitPlan[], running: readonly Job[], lanes: readonly Lane[], states: MachineState[],
  drained: ReadonlySet<LaneId>, input: PreemptionInput | undefined, atIso: string, pl?: PriorityLanesInput,
): PreemptPlan[] {
  if (!input) return [];
  const at = new Date(atIso).getTime();
  const flying = running.filter((j) => inFlight(j, at));
  const taken = new Set(flying.map((j) => j.id));
  const preempting = new Set(flying.map((j) => j.preempted!.by));
  const waiting = new Set(waits.map((w) => w.jobId));
  const plans: PreemptPlan[] = [];
  for (const { job } of ordered) {
    if (!waiting.has(job.id) || preempting.has(job.id)) continue;
    const options = running.flatMap((r) => {
      if (r.status !== 'running' || taken.has(r.id) || r.priority >= job.priority) return [];
      if (!input.parkingExecutors.includes(r.spec.executor) || r.agentSession === undefined || r.startedAt === undefined) return [];
      if (at - new Date(r.startedAt).getTime() < input.minRunMs) return [];
      const lane = lanes.find((l) => l.jobId === r.id && l.state === 'busy' && !drained.has(l.id));
      const s = lane ? states.find((m) => m.machine.id === lane.machineId) : undefined;
      return lane && s && fitsWhenFreed(s, job, lane, r, pl) ? [{ r, lane }] : [];
    });
    const best = options.sort((a, b) => a.r.priority - b.r.priority || b.r.startedAt!.localeCompare(a.r.startedAt!) || a.r.id.localeCompare(b.r.id))[0];
    if (!best) continue;
    const { r, lane } = best;
    taken.add(r.id);
    const ran = Math.round((at - new Date(r.startedAt!).getTime()) / MINUTE_MS);
    plans.push({
      jobId: r.id, laneId: lane.id, machineId: lane.machineId, by: job.id, priority: r.priority, byPriority: job.priority,
      reason: `preempts ${r.id} (priority ${r.priority}, running ${ran} min) on ${lane.id}: job ${job.id} of priority ${job.priority} waits and every lane it may use is busy`,
    });
  }
  return plans;
}
