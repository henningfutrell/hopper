// Unhealthy lanes and the lane a rerun avoids, in the Decision (issue #2234, src/engine/lane-health.ts). An unhealthy lane
// takes no new job until its time out passed: the machine counts it as one lane fewer, and a new lane there gets another
// number. A rerun of a job that failed for its lane's fault goes to another machine when one may take it, else to another
// lane of that machine, and to that lane only when there is no other. Pure.
import type { JobId, Lane, LaneId, MachineSnapshot, StartPlan } from '../domain/types.ts';
import type { UnhealthyLane } from '../domain/machines.ts';

/** The machine's lanes out at `at`. */
export const outAt = (m: MachineSnapshot, at: string): UnhealthyLane[] => (m.unhealthyLanes ?? []).filter((l) => l.until > at);

/**
 * The machine as the Decision sees it: one lane fewer for each lane out that holds no job (a busy one counts already), so
 * no other lane drains for it.
 */
export function withoutOut(m: MachineSnapshot, lanes: readonly Lane[], at: string): MachineSnapshot {
  const held = new Set(lanes.filter((l) => l.machineId === m.id && l.state !== 'idle').map((l) => l.id));
  const out = outAt(m, at).filter((l) => !held.has(l.laneId)).length;
  return out ? { ...m, maxLanes: Math.max(0, m.maxLanes - out) } : m;
}

/** Of `options`, the ones on a machine other than the avoided lane's, when there is one; else all of them. */
export function awayFrom<T extends { machine: { id: string } }>(options: T[], avoid: LaneId | undefined): T[] {
  if (avoid === undefined) return options;
  const away = options.filter((o) => !avoid.startsWith(`${o.machine.id}/lane-`));
  return away.length ? away : options;
}

/** The idle lane a job takes off `freeIdle`: the first one it does not avoid, else the first. */
export function takeIdle(freeIdle: Lane[], avoid: LaneId | undefined): Lane | undefined {
  const i = freeIdle.findIndex((l) => l.id !== avoid);
  return i < 0 ? freeIdle.shift() : freeIdle.splice(i, 1)[0];
}

/**
 * The new lanes of `start` numbered past the lanes out and the lane each job avoids, where a store's lowest free number
 * would be one of them: the lowest number not open, out, avoided or opened by another start.
 */
export function numberNewLanes(start: StartPlan[], machines: readonly MachineSnapshot[], lanes: readonly Lane[], at: string, avoidLanes: Record<JobId, LaneId> = {}): StartPlan[] {
  const taken = new Set<LaneId>([...lanes.map((l) => l.id), ...start.flatMap((s) => (s.opens ? [s.opens] : []))]);
  const outIds = new Set(machines.flatMap((m) => outAt(m, at).map((l) => l.laneId)));
  return start.map((s) => {
    if (s.laneId !== null) return s;
    const skip = (id: LaneId): boolean => taken.has(id) || outIds.has(id) || avoidLanes[s.jobId] === id;
    const own = (id: LaneId | undefined): boolean => id !== undefined && id.startsWith(`${s.machineId}/lane-`);
    const named = s.opens && !outIds.has(s.opens) && avoidLanes[s.jobId] !== s.opens;
    if (named || (![...outIds].some(own) && !own(avoidLanes[s.jobId]))) return s;
    if (s.opens) taken.delete(s.opens);
    let n = 1;
    while (skip(`${s.machineId}/lane-${n}`)) n++;
    const opens: LaneId = `${s.machineId}/lane-${n}`;
    taken.add(opens);
    return { ...s, opens };
  });
}

/** Why a machine with lanes out leaves them unused (issue #2234), or undefined when none is out. */
export function outReason(m: MachineSnapshot, at: string): string | undefined {
  const out = outAt(m, at);
  if (out.length === 0) return undefined;
  return out.map((l) => `lane ${l.laneId} is unhealthy: ${l.failures} starts in a row failed with the same start error (${firstLine(l.error)}); no new job there until ${l.until}`).join('; ');
}

const firstLine = (error: string): string => {
  const head = error.split('\n')[0]!;
  const cut = head.indexOf(': ');
  return cut > 0 ? head.slice(0, cut) : head.slice(0, 120);
};
