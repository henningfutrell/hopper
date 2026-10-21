// The memory floor (issue #2291, design.md "The memory floor"), steps 7 and 7c. A machine takes a new job, or a job back,
// only while its memory available, less what the jobs it started lately keep and what the new job needs, stays at or
// above its floor; else the job waits for memory, and preempts nothing. Below the floor itself, the job that started
// there last is paused: parked on the Park button's path, its work kept, and queued again to resume there. One pause
// per machine at a time. Issue #2303: on a machine a job waits for memory on, the agents of the jobs on their own wait there
// end (their sessions kept), as nothing else frees memory while nothing runs. Pure: the clock is `at`.
import {
  MEMORY_FLOOR_MIN_GIB, MEMORY_FLOOR_PERCENT, MEMORY_PAUSE_EVERY_MS, MEMORY_PER_JOB_GIB, MEMORY_RAMP_MS, MEMORY_WAIT,
  type ExpectedCost, type Job, type JobId, type Lane, type MachineId, type MachineSnapshot, type MemoryPausePlan, type ResourceReading,
  type WaitReleasePlan, type WaitSession,
} from '../domain/types.ts';

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${Math.round((bytes / GIB) * 10) / 10} GiB`;

/** A machine's memory as one Decision counts it: what it has, its floor, a job's need, and what is kept and for how many jobs. */
export interface MemoryRoom { availableBytes: number; floorBytes: number; perJobBytes: number; keptBytes: number; kept: number }

/** The memory available the floor reads: Linux's, or on WSL Windows' own free memory when that is lower (issue #868). */
const availableOf = (r: ResourceReading): number =>
  (r.wsl && r.hostMemFreeBytes !== undefined ? Math.min(r.memAvailableBytes, r.hostMemFreeBytes) : r.memAvailableBytes);

/** The machine's memory, floor and need for a job; undefined when it has no memory reading or its floor is 0 (off). */
function floorOf(m: MachineSnapshot): Omit<MemoryRoom, 'keptBytes' | 'kept'> | undefined {
  const r = m.resources;
  if (!r || r.memTotalBytes <= 0) return undefined;
  const own = m.memoryFloor?.floorGiB;
  const floorBytes = own !== undefined ? own * GIB : Math.max(MEMORY_FLOOR_MIN_GIB * GIB, (r.memTotalBytes * MEMORY_FLOOR_PERCENT) / 100);
  if (floorBytes <= 0) return undefined;
  return { availableBytes: availableOf(r), floorBytes, perJobBytes: (m.memoryFloor?.perJobGiB ?? MEMORY_PER_JOB_GIB) * GIB };
}

/** A job claimed, or one that started or resumed less than `MEMORY_RAMP_MS` ago, has not taken its memory yet. */
const lately = (j: Job, at: number): boolean => j.status === 'claimed' || (j.startedAt !== undefined && at - Date.parse(j.startedAt) < MEMORY_RAMP_MS);

/** The machine's memory room at the start of a Decision: each job on its lanes that started lately keeps a job's memory. */
export function memoryRoom(m: MachineSnapshot, lanes: readonly Lane[], running: readonly Job[], atIso: string): MemoryRoom | undefined {
  const f = floorOf(m);
  if (!f) return undefined;
  const here = new Set(lanes.filter((l) => l.machineId === m.id).map((l) => l.id));
  const at = Date.parse(atIso);
  const kept = running.filter((j) => j.laneId !== undefined && here.has(j.laneId) && lately(j, at)).length;
  return { ...f, keptBytes: kept * f.perJobBytes, kept };
}

/** What a new job needs: a job's memory, or its expected memory peak when that is more. */
const needOf = (room: MemoryRoom, cost: ExpectedCost | undefined): number => Math.max(room.perJobBytes, cost?.memoryBytes?.peak ?? 0);

/** Whether a new job fits the machine's memory room. No room counted (no reading, floor off): it fits. */
export const memoryAdmits = (room: MemoryRoom | undefined, cost?: ExpectedCost): boolean =>
  !room || room.availableBytes - room.keptBytes - needOf(room, cost) >= room.floorBytes;

/** Count a job placed on the machine, for the jobs placed after it in this Decision. */
export function keepMemory(room: MemoryRoom | undefined, cost: ExpectedCost | undefined): void {
  if (!room) return;
  room.keptBytes += needOf(room, cost);
  room.kept += 1;
}

/** The wait reason of a job that has a lane on these machines but whose memory none of them holds. */
export function memoryWait(states: readonly { machine: MachineSnapshot; memory?: MemoryRoom }[], cost: ExpectedCost | undefined): string {
  const each = states.flatMap(({ machine: m, memory: r }) => (r
    ? [`${m.id} has ${gib(r.availableBytes)} available${r.kept ? `, ${gib(r.keptBytes)} of it kept for ${r.kept} job${r.kept === 1 ? '' : 's'} started lately` : ''}; a new job needs ${gib(needOf(r, cost))} over its floor of ${gib(r.floorBytes)}`]
    : []));
  return `${MEMORY_WAIT}: ${each.join('; ')}`;
}

/**
 * Step 7c: for each online machine whose memory available is below its floor, pause the running job that started there
 * last: its executor parks, it has an agent session to resume, and no preemption names it. None on a machine with a
 * memory pause less than `MEMORY_PAUSE_EVERY_MS` old, so the park frees memory and a new reading shows it first.
 */
export function memoryPauses(
  machines: readonly MachineSnapshot[], lanes: readonly Lane[], running: readonly Job[], waiting: readonly Job[],
  parking: readonly string[] | undefined, atIso: string, taken: ReadonlySet<JobId>, pausedAt: Readonly<Record<string, string>> = {},
): MemoryPausePlan[] {
  if (!parking?.length) return [];
  const at = Date.parse(atIso);
  const plans: MemoryPausePlan[] = [];
  for (const m of machines) {
    const f = floorOf(m);
    if (!f || !m.online || f.availableBytes >= f.floorBytes) continue;
    const recent = (iso: string | undefined): boolean => iso !== undefined && at - Date.parse(iso) < MEMORY_PAUSE_EVERY_MS;
    if (recent(pausedAt[m.id]) || [...running, ...waiting].some((j) => j.memoryPaused?.machineId === m.id && recent(j.memoryPaused.at))) continue;
    const options = running.flatMap((j) => {
      if (j.status !== 'running' || j.startedAt === undefined || j.agentSession === undefined || j.preempted !== undefined || taken.has(j.id) || !parking.includes(j.spec.executor)) return [];
      const lane = lanes.find((l) => l.jobId === j.id && l.state === 'busy' && l.machineId === m.id);
      return lane ? [{ j, lane }] : [];
    });
    const last = options.sort((a, b) => b.j.startedAt!.localeCompare(a.j.startedAt!) || a.j.id.localeCompare(b.j.id))[0];
    if (!last) continue;
    plans.push({
      jobId: last.j.id, laneId: last.lane.id, machineId: m.id, availableBytes: f.availableBytes, floorBytes: f.floorBytes,
      reason: `pauses ${last.j.id} on ${last.lane.id}: ${m.id} has ${gib(f.availableBytes)} available, below its floor of ${gib(f.floorBytes)}; ${last.j.id} started there last`,
    });
  }
  return plans;
}

/**
 * Issue #2303: on each machine a job waits for memory on, end the agent of every job on its own wait there, the oldest wait
 * first. Each keeps its wait, work tree and agent session, and resumes its session when its wait ends. Not counted as memory
 * freed in this Decision: the next reading shows what the ended agents held.
 */
export function waitReleases(sessions: readonly WaitSession[] | undefined, short: ReadonlySet<MachineId>, atIso: string): WaitReleasePlan[] {
  const at = Date.parse(atIso);
  return (sessions ?? []).filter((s) => short.has(s.machineId))
    .sort((a, b) => a.since.localeCompare(b.since) || a.jobId.localeCompare(b.jobId))
    .map((s) => ({
      jobId: s.jobId, machineId: s.machineId,
      reason: `releases the agent of ${s.jobId} on ${s.machineId}: a job waits for memory there, and ${s.jobId} waits on its own since ${Math.round((at - Date.parse(s.since)) / 60_000)} min ago; it resumes its session when its wait ends`,
    }));
}
