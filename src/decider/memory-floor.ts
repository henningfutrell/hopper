// The memory floor (issue #2291, design.md "The memory floor"), steps 7 and 7c. A machine takes a new job, or a job back,
// only while its memory available, less what the jobs it started lately keep and what the new job needs, stays at or
// above its floor; else the job waits for memory, and preempts nothing. Below the floor itself, the job that started
// there last is paused: parked on the Park button's path, its work kept, and queued again to resume there. One pause
// per machine at a time. Issues #2303, #2326: the agent of every job on its own wait ends (its session kept), memory short or
// not, so no waiting job holds memory. Issue #2499: the memory a job's scope still holds with no lane is in the reading, and the
// wait names it. Machines whose readings name one kernel are a host pool: a job also needs room in that kernel's memory,
// less what every machine of the pool keeps, over the kernel's own floor. A machine whose tasks wait on memory (its memory
// pressure at or above MEMORY_PRESSURE_PERCENT) takes no new job. Pure: the clock is `at`.
import {
  MEMORY_FLOOR_MIN_GIB, MEMORY_FLOOR_PERCENT, MEMORY_PAUSE_EVERY_MS, MEMORY_PRESSURE_PERCENT, MEMORY_PER_JOB_GIB, MEMORY_RAMP_MS, MEMORY_WAIT, WAIT_RELEASE_AFTER_MS,
  type ExpectedCost, type Job, type JobId, type Lane, type MachineSnapshot, type MemoryPausePlan, type ResourceReading,
  type WaitReleasePlan, type WaitSession,
} from '../domain/types.ts';

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${Math.round((bytes / GIB) * 10) / 10} GiB`;

/**
 * A machine's memory as one Decision counts it: what it has, its floor, a job's need, and what is kept and for how many jobs.
 * `waitingBytes` (issue #2499): of what it has in use, what its job scopes hold for `waiting` jobs with no lane in use there.
 * `pressure` (issue #2499): its memory pressure, the share of the last 10 s some task waited on memory, in percent.
 */
export interface MemoryRoom { availableBytes: number; floorBytes: number; perJobBytes: number; keptBytes: number; kept: number; waitingBytes: number; waiting: number; pool?: HostPool; pressure?: number }

/**
 * Issue #2499: the memory of one kernel that the machines of a host pool share, one object for all of them: its memory
 * available (Windows' free memory when one of them reads it lower), its floor, and what each of them keeps.
 */
export interface HostPool { machines: string[]; availableBytes: number; floorBytes: number; keptBytes: number; kept: number }

/** The memory available the floor reads: Linux's, or on WSL Windows' own free memory when that is lower (issue #868). */
const availableOf = (r: ResourceReading): number =>
  (r.wsl && r.hostMemFreeBytes !== undefined ? Math.min(r.memAvailableBytes, r.hostMemFreeBytes) : r.memAvailableBytes);

/** The machine's memory, floor and need for a job; undefined when it has no memory reading or its floor is 0 (off). */
function floorOf(m: MachineSnapshot): Omit<MemoryRoom, 'keptBytes' | 'kept' | 'waitingBytes' | 'waiting'> | undefined {
  const r = m.resources;
  if (!r || r.memTotalBytes <= 0) return undefined;
  const own = m.memoryFloor?.floorGiB;
  const floorBytes = own !== undefined ? own * GIB : Math.max(MEMORY_FLOOR_MIN_GIB * GIB, (r.memTotalBytes * MEMORY_FLOOR_PERCENT) / 100);
  if (floorBytes <= 0) return undefined;
  return {
    availableBytes: availableOf(r), floorBytes, perJobBytes: (m.memoryFloor?.perJobGiB ?? MEMORY_PER_JOB_GIB) * GIB,
    ...(r.memPressure ? { pressure: r.memPressure.someAvg10 } : {}),
  };
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
  const onLane = new Set(lanes.flatMap((l) => (l.machineId === m.id && l.state !== 'idle' && l.jobId !== undefined ? [l.jobId] : [])));
  const waiting = Object.entries(m.resources?.jobMemoryBytes ?? {}).filter(([id, bytes]) => !onLane.has(id) && bytes > 0);
  return { ...f, keptBytes: kept * f.perJobBytes, kept, waitingBytes: waiting.reduce((n, [, b]) => n + b, 0), waiting: waiting.length };
}

/**
 * Issue #2499: join the machines on one kernel (the same `bootId`) into a host pool. The kernel's memory is a reading's
 * own when it is not in a container, else the kernel's as it says it; the lowest of them counts, and Windows' free memory
 * when one of them reads it lower. A pool is two machines or more, or one in a container: else its own room says it all.
 * Only machines with a memory room count: a floor of 0 keeps a machine out.
 */
export function poolHosts(states: readonly { machine: MachineSnapshot; memory?: MemoryRoom }[]): void {
  const byBoot = new Map<string, { machine: MachineSnapshot; memory: MemoryRoom }[]>();
  for (const s of states) {
    const boot = s.machine.resources?.bootId;
    if (boot !== undefined && s.memory) byBoot.set(boot, [...(byBoot.get(boot) ?? []), { machine: s.machine, memory: s.memory }]);
  }
  for (const members of byBoot.values()) {
    if (members.length < 2 && !members.some((s) => s.machine.resources?.container)) continue;
    const kernels = members.flatMap(({ machine: { resources: r } }) => (!r ? []
      : !r.container ? [{ total: r.memTotalBytes, available: r.memAvailableBytes }]
        : r.kernelMemTotalBytes !== undefined && r.kernelMemAvailableBytes !== undefined ? [{ total: r.kernelMemTotalBytes, available: r.kernelMemAvailableBytes }] : []));
    if (!kernels.length) continue;
    const windows = members.flatMap(({ machine: { resources: r } }) => (r?.wsl && r.hostMemFreeBytes !== undefined ? [r.hostMemFreeBytes] : []));
    const total = Math.max(...kernels.map((k) => k.total));
    const pool: HostPool = {
      machines: members.map((s) => s.machine.id).sort(),
      availableBytes: Math.min(...kernels.map((k) => k.available), ...windows),
      floorBytes: Math.max(MEMORY_FLOOR_MIN_GIB * GIB, (total * MEMORY_FLOOR_PERCENT) / 100),
      keptBytes: members.reduce((n, s) => n + s.memory.keptBytes, 0),
      kept: members.reduce((n, s) => n + s.memory.kept, 0),
    };
    for (const s of members) s.memory.pool = pool;
  }
}

/** What a new job needs: a job's memory, or its expected memory peak when that is more. */
const needOf = (room: MemoryRoom, cost: ExpectedCost | undefined): number => Math.max(room.perJobBytes, cost?.memoryBytes?.peak ?? 0);

const ownAdmits = (room: MemoryRoom, cost: ExpectedCost | undefined): boolean => room.availableBytes - room.keptBytes - needOf(room, cost) >= room.floorBytes;
const poolAdmits = (room: MemoryRoom, cost: ExpectedCost | undefined): boolean =>
  !room.pool || room.pool.availableBytes - room.pool.keptBytes - needOf(room, cost) >= room.pool.floorBytes;

const pressed = (room: MemoryRoom): boolean => room.pressure !== undefined && room.pressure >= MEMORY_PRESSURE_PERCENT;

/** Whether a new job fits the machine's memory room, and its host pool's, with no memory pressure. No room counted (no reading, floor off): it fits. */
export const memoryAdmits = (room: MemoryRoom | undefined, cost?: ExpectedCost): boolean =>
  !room || (ownAdmits(room, cost) && !pressed(room) && poolAdmits(room, cost));

/** Count a job placed on the machine, and on its host pool, for the jobs placed after it in this Decision. */
export function keepMemory(room: MemoryRoom | undefined, cost: ExpectedCost | undefined): void {
  if (!room) return;
  for (const r of room.pool ? [room, room.pool] : [room]) {
    r.keptBytes += needOf(room, cost);
    r.kept += 1;
  }
}

const keptText = (r: { keptBytes: number; kept: number }): string => (r.kept ? `, ${gib(r.keptBytes)} of it kept for ${r.kept} job${r.kept === 1 ? '' : 's'} started lately` : '');

/** The host a machine of a host pool shares, and with which machines. */
const hostOf = (id: string, pool: HostPool): string => {
  const others = pool.machines.filter((m) => m !== id);
  return `host${others.length ? ` (shared with ${others.join(', ')})` : ''}`;
};

/** What a machine's memory room, or else its host pool's, holds against a new job's need; `of`: the machine, for its host. */
export function memoryShort(r: MemoryRoom, cost: ExpectedCost | undefined, of?: string): string {
  if (ownAdmits(r, cost) && pressed(r)) {
    return `its memory is under pressure: its tasks waited on memory ${Math.round(r.pressure!)}% of the last 10 s, and a new job starts only below ${MEMORY_PRESSURE_PERCENT}%`;
  }
  if (ownAdmits(r, cost) && r.pool) {
    const p = r.pool;
    return `its ${hostOf(of ?? '', p)} has ${gib(p.availableBytes)} available${keptText(p)}, and a new job needs ${gib(needOf(r, cost))} over its floor of ${gib(p.floorBytes)}`;
  }
  return `${gib(r.availableBytes)} available${r.waiting ? ` (${gib(r.waitingBytes)} is held by ${r.waiting} job${r.waiting === 1 ? '' : 's'} with no lane)` : ''}${keptText(r)}, and a new job needs ${gib(needOf(r, cost))} over its floor of ${gib(r.floorBytes)}`;
}

/** The wait reason of a job that has a lane on these machines but whose memory none of them holds. */
export function memoryWait(states: readonly { machine: MachineSnapshot; memory?: MemoryRoom }[], cost: ExpectedCost | undefined): string {
  const each = states.flatMap(({ machine: m, memory: r }) => {
    if (!r) return [];
    const short = memoryShort(r, cost, m.id);
    return [short.startsWith('its ') ? `${m.id}'s ${short.slice(4)}` : `${m.id} has ${short}`];
  });
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
 * Issues #2303, #2326: end the agent of every job on its own wait, on every machine, the oldest wait first, whether or not a
 * job waits for memory, once its wait is `WAIT_RELEASE_AFTER_MS` old. Each keeps its wait, work tree and agent session, and resumes its session when its wait ends, on any
 * machine with room once its checkpoint is taken. Not counted as memory freed in this Decision: the next reading shows it.
 */
export function waitReleases(sessions: readonly WaitSession[] | undefined, atIso: string): WaitReleasePlan[] {
  const at = Date.parse(atIso);
  return (sessions ?? []).filter((s) => at - Date.parse(s.since) >= WAIT_RELEASE_AFTER_MS)
    .sort((a, b) => a.since.localeCompare(b.since) || a.jobId.localeCompare(b.jobId))
    .map((s) => ({
      jobId: s.jobId, machineId: s.machineId,
      reason: `releases the agent of ${s.jobId} on ${s.machineId}: it waits on its own since ${Math.round((at - Date.parse(s.since)) / 60_000)} min ago, and a waiting job holds no agent; it resumes its session when its wait ends, on any machine with room`,
    }));
}
