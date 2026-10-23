// The memory pause (issue #2291, design.md "The memory floor"), step 7c. Below its floor, a machine pauses the running job
// that started there last: parked on the Park button's path, its work kept, and queued again to resume there. One pause
// per machine at a time. Issue #2499: also a machine whose memory pressure is at or above MEMORY_PRESSURE_PAUSE_PERCENT, and
// a host pool below the kernel's floor, though each of its machines has memory of its own: the job that started last on any
// of them, one pause at a time for the pool. Pure: the clock is `at`.
import {
  MEMORY_PAUSE_EVERY_MS, MEMORY_PRESSURE_PAUSE_PERCENT,
  type Job, type JobId, type Lane, type MachineSnapshot, type MemoryPausePlan,
} from '../domain/types.ts';
import { floorOf, gib, kernelFloor, kernelOf, poolsOf } from './memory-floor.ts';

/** Machines whose memory holds no more running job, and why: the memory available and the floor the pause reads. */
interface Short { machines: MachineSnapshot[]; availableBytes: number; floorBytes: number; why: string }

/** Each online machine below its own floor, or with memory pressure at or above the pause's share. */
function ownShort(m: MachineSnapshot, at: number): Short | undefined {
  const f = floorOf(m, at);
  if (!f || !m.online) return undefined;
  const base = { machines: [m], availableBytes: f.availableBytes, floorBytes: f.floorBytes };
  if (f.availableBytes < f.floorBytes) return { ...base, why: `${m.id} has ${gib(f.availableBytes)} available, below its floor of ${gib(f.floorBytes)}` };
  if (f.pressure !== undefined && f.pressure >= MEMORY_PRESSURE_PAUSE_PERCENT) {
    return { ...base, why: `${m.id}'s memory is under pressure: its tasks waited on memory ${Math.round(f.pressure)}% of the last 10 s, at or above ${MEMORY_PRESSURE_PAUSE_PERCENT}%` };
  }
  return undefined;
}

/** Each host pool of online machines with a floor whose kernel's memory available is below the kernel's floor. */
function poolShort(machines: readonly MachineSnapshot[], at: number): Short[] {
  const own = machines.filter((m) => m.online && floorOf(m, at)).map((machine) => ({ machine }));
  return poolsOf(own).flatMap((members) => {
    const kernels = members.flatMap(({ machine: { resources: r } }) => (r ? kernelOf(r) : []));
    if (!kernels.length) return [];
    const windows = members.flatMap(({ machine: { resources: r } }) => (r?.wsl && r.hostMemFreeBytes !== undefined ? [r.hostMemFreeBytes] : []));
    const availableBytes = Math.min(...kernels.map((k) => k.available), ...windows);
    const floorBytes = kernelFloor(Math.max(...kernels.map((k) => k.total)));
    if (availableBytes >= floorBytes) return [];
    const ms = members.map((s) => s.machine).sort((a, b) => a.id.localeCompare(b.id));
    return [{ machines: ms, availableBytes, floorBytes, why: `the host of ${ms.map((m) => m.id).join(', ')} has ${gib(availableBytes)} available, below its floor of ${gib(floorBytes)}` }];
  });
}

/**
 * Step 7c: for each machine, then each host pool, whose memory holds no more running job, pause the running job that
 * started there last: its executor parks, it has an agent session to resume, and no preemption names it. None where a
 * memory pause on one of its machines is less than `MEMORY_PAUSE_EVERY_MS` old, so the park frees memory and a new reading
 * shows it first; a pool pauses none when one of its machines pauses in this Decision.
 */
export function memoryPauses(
  machines: readonly MachineSnapshot[], lanes: readonly Lane[], running: readonly Job[], waiting: readonly Job[],
  parking: readonly string[] | undefined, atIso: string, taken: ReadonlySet<JobId>, pausedAt: Readonly<Record<string, string>> = {},
): MemoryPausePlan[] {
  if (!parking?.length) return [];
  const at = Date.parse(atIso);
  const recent = (iso: string | undefined): boolean => iso !== undefined && at - Date.parse(iso) < MEMORY_PAUSE_EVERY_MS;
  const pausing = new Set<string>();
  const plans: MemoryPausePlan[] = [];
  const shorts = [...machines.flatMap((m) => ownShort(m, at) ?? []), ...poolShort(machines, at)];
  for (const s of shorts) {
    const ids = new Set(s.machines.map((m) => m.id));
    if ([...ids].some((id) => pausing.has(id) || recent(pausedAt[id]))) continue;
    if ([...running, ...waiting].some((j) => j.memoryPaused && ids.has(j.memoryPaused.machineId) && recent(j.memoryPaused.at))) continue;
    const options = running.flatMap((j) => {
      if (j.status !== 'running' || j.startedAt === undefined || j.agentSession === undefined || j.preempted !== undefined || taken.has(j.id) || !parking.includes(j.spec.executor)) return [];
      const lane = lanes.find((l) => l.jobId === j.id && l.state === 'busy' && ids.has(l.machineId));
      return lane ? [{ j, lane }] : [];
    });
    const last = options.sort((a, b) => b.j.startedAt!.localeCompare(a.j.startedAt!) || a.j.id.localeCompare(b.j.id))[0];
    if (!last) continue;
    for (const id of ids) pausing.add(id);
    plans.push({
      jobId: last.j.id, laneId: last.lane.id, machineId: last.lane.machineId, availableBytes: s.availableBytes, floorBytes: s.floorBytes,
      reason: `pauses ${last.j.id} on ${last.lane.id}: ${s.why}; ${last.j.id} started there last`,
    });
  }
  return plans;
}
