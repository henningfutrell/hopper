// The memory floor (issue #2291, design.md "The memory floor"), steps 7 and 7c. A machine takes a new job, or a job back,
// only while its memory available, less what the jobs it started lately keep and what the new job needs, stays at or
// above its floor; else the job waits for memory, and preempts nothing. Below the floor itself, the job that started
// there last is paused: parked on the Park button's path, its work kept, and queued again to resume there. One pause
// per machine at a time. Issues #2303, #2326: the agent of every job on its own wait ends (its session kept), memory short or
// not, so no waiting job holds memory. Issue #2499: the memory a job's scope still holds with no lane is in the reading, and the
// wait names it. Machines whose readings name one kernel are a host pool: a job also needs room in that kernel's memory,
// less what every machine of the pool keeps, over the kernel's own floor. A machine whose tasks wait on memory (its memory
// pressure at or above MEMORY_PRESSURE_PERCENT, or over MEMORY_PRESSURE_60_PERCENT of the last minute) takes no new job, nor one that saw an OOM kill less than MEMORY_OOM_KILL_MS
// ago. The memory pause is in memory-pause.ts. Pure: the clock is `at`.
import {
  MEMORY_FLOOR_MIN_GIB, MEMORY_FLOOR_PERCENT, MEMORY_OOM_KILL_MS, MEMORY_PRESSURE_60_PERCENT, MEMORY_PRESSURE_PERCENT, MEMORY_PER_JOB_GIB, MEMORY_RAMP_MS, MEMORY_WAIT, WAIT_RELEASE_AFTER_MS,
  type ExpectedCost, type Job, type Lane, type MachineSnapshot, type ResourceReading,
  type WaitReleasePlan, type WaitSession,
} from '../domain/types.ts';

const GIB = 1024 ** 3;
export const gib = (bytes: number): string => `${Math.round((bytes / GIB) * 10) / 10} GiB`;

/**
 * A machine's memory as one Decision counts it: what it has, its floor, a job's need, and what is kept and for how many jobs.
 * `waitingBytes` (issue #2499): of what it has in use, what its job scopes hold for `waiting` jobs with no lane in use there.
 * `pressure` (issue #2499): its memory pressure, the share of the last 10 s some task waited on memory, in percent;
 * `pressure60` (issue #2622 part 5), of the last 60 s.
 * `oomKillMs` (issue #2499): how long ago it saw an OOM kill, when that is less than MEMORY_OOM_KILL_MS.
 */
export interface MemoryRoom {
  availableBytes: number; floorBytes: number; perJobBytes: number; keptBytes: number; kept: number; waitingBytes: number; waiting: number;
  pool?: HostPool; pressure?: number; pressure60?: number; oomKillMs?: number;
}

/**
 * Issue #2499: the memory of one kernel that the machines of a host pool share, one object for all of them: its memory
 * available (Windows' free memory when one of them reads it lower), its floor, and what each of them keeps.
 */
export interface HostPool { machines: string[]; availableBytes: number; floorBytes: number; keptBytes: number; kept: number }

/** The memory available the floor reads: Linux's, or on WSL Windows' own free memory when that is lower (issue #868). */
const availableOf = (r: ResourceReading): number =>
  (r.wsl && r.hostMemFreeBytes !== undefined ? Math.min(r.memAvailableBytes, r.hostMemFreeBytes) : r.memAvailableBytes);

/** A kernel's own floor: 10% of its memory, at least 1 GiB. */
export const kernelFloor = (total: number): number => Math.max(MEMORY_FLOOR_MIN_GIB * GIB, (total * MEMORY_FLOOR_PERCENT) / 100);

/** The machine's floor and a job's memory there; undefined when it has no memory reading or its floor is 0 (off). */
function ownFloor(m: MachineSnapshot): { r: ResourceReading; floorBytes: number; perJobBytes: number } | undefined {
  const r = m.resources;
  if (!r || r.memTotalBytes <= 0) return undefined;
  const own = m.memoryFloor?.floorGiB;
  const floorBytes = own !== undefined ? own * GIB : kernelFloor(r.memTotalBytes);
  return floorBytes > 0 ? { r, floorBytes, perJobBytes: (m.memoryFloor?.perJobGiB ?? MEMORY_PER_JOB_GIB) * GIB } : undefined;
}

/** The machine's memory, floor and need for a job; undefined when it has no memory reading or its floor is 0 (off). */
export function floorOf(m: MachineSnapshot, at: number): Omit<MemoryRoom, 'keptBytes' | 'kept' | 'waitingBytes' | 'waiting'> | undefined {
  const o = ownFloor(m);
  if (!o) return undefined;
  const { r, floorBytes, perJobBytes } = o;
  const killMs = r.memOomKillAt !== undefined ? at - Date.parse(r.memOomKillAt) : undefined;
  return {
    availableBytes: availableOf(r), floorBytes, perJobBytes,
    ...(r.memPressure ? { pressure: r.memPressure.someAvg10 } : {}),
    ...(r.memPressure?.someAvg60 !== undefined ? { pressure60: r.memPressure.someAvg60 } : {}),
    ...(killMs !== undefined && killMs >= 0 && killMs < MEMORY_OOM_KILL_MS ? { oomKillMs: killMs } : {}),
  };
}

/** A job claimed, or one that started or resumed less than `MEMORY_RAMP_MS` ago, has not taken its memory yet. */
const lately = (j: Job, at: number): boolean => j.status === 'claimed' || (j.startedAt !== undefined && at - Date.parse(j.startedAt) < MEMORY_RAMP_MS);

/** The machine's memory room at the start of a Decision: each job on its lanes that started lately keeps a job's memory. */
export function memoryRoom(m: MachineSnapshot, lanes: readonly Lane[], running: readonly Job[], atIso: string): MemoryRoom | undefined {
  const at = Date.parse(atIso);
  const f = floorOf(m, at);
  if (!f) return undefined;
  const here = new Set(lanes.filter((l) => l.machineId === m.id).map((l) => l.id));
  const kept = running.filter((j) => j.laneId !== undefined && here.has(j.laneId) && lately(j, at)).length;
  const onLane = new Set(lanes.flatMap((l) => (l.machineId === m.id && l.state !== 'idle' && l.jobId !== undefined ? [l.jobId] : [])));
  const waiting = Object.entries(m.resources?.jobMemoryBytes ?? {}).filter(([id, bytes]) => !onLane.has(id) && bytes > 0);
  return { ...f, keptBytes: kept * f.perJobBytes, kept, waitingBytes: waiting.reduce((n, [, b]) => n + b, 0), waiting: waiting.length };
}

/** The kernel's own memory, total and available, as a reading says it: its own when not in a container. */
export const kernelOf = (r: ResourceReading): { total: number; available: number }[] => (!r.container ? [{ total: r.memTotalBytes, available: r.memAvailableBytes }]
  : r.kernelMemTotalBytes !== undefined && r.kernelMemAvailableBytes !== undefined ? [{ total: r.kernelMemTotalBytes, available: r.kernelMemAvailableBytes }] : []);

/** The machines of `ms` that make host pools: per boot id, two machines or more, or one in a container. */
export function poolsOf<T extends { machine: MachineSnapshot }>(ms: readonly T[]): T[][] {
  const byBoot = new Map<string, T[]>();
  for (const s of ms) {
    const boot = s.machine.resources?.bootId;
    if (boot !== undefined) byBoot.set(boot, [...(byBoot.get(boot) ?? []), s]);
  }
  return [...byBoot.values()].filter((members) => members.length >= 2 || members.some((s) => s.machine.resources?.container));
}

/**
 * Issue #2499: join the machines on one kernel (the same `bootId`) into a host pool. The kernel's memory is a reading's
 * own when it is not in a container, else the kernel's as it says it; the lowest of them counts, and Windows' free memory
 * when one of them reads it lower. A pool is two machines or more, or one in a container: else its own room says it all.
 * Only machines with a memory room count: a floor of 0 keeps a machine out.
 */
export function poolHosts(states: readonly { machine: MachineSnapshot; memory?: MemoryRoom }[]): void {
  for (const members of poolsOf(states.flatMap((s) => (s.memory ? [{ machine: s.machine, memory: s.memory }] : [])))) {
    const kernels = members.flatMap(({ machine: { resources: r } }) => (r ? kernelOf(r) : []));
    if (!kernels.length) continue;
    const windows = members.flatMap(({ machine: { resources: r } }) => (r?.wsl && r.hostMemFreeBytes !== undefined ? [r.hostMemFreeBytes] : []));
    const total = Math.max(...kernels.map((k) => k.total));
    const pool: HostPool = {
      machines: members.map((s) => s.machine.id).sort(),
      availableBytes: Math.min(...kernels.map((k) => k.available), ...windows),
      floorBytes: kernelFloor(total),
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

const pressed10 = (room: MemoryRoom): boolean => room.pressure !== undefined && room.pressure >= MEMORY_PRESSURE_PERCENT;
const pressed60 = (room: MemoryRoom): boolean => room.pressure60 !== undefined && room.pressure60 > MEMORY_PRESSURE_60_PERCENT;
const pressed = (room: MemoryRoom): boolean => pressed10(room) || pressed60(room);
/** Issue #2499: under memory pressure, or an OOM kill lately: the machine takes no new job, whatever memory it reads. */
const stalled = (room: MemoryRoom): boolean => pressed(room) || room.oomKillMs !== undefined;

/** Whether a new job fits the machine's memory room, and its host pool's, with no memory pressure or OOM kill lately. No room counted (no reading, floor off): it fits. */
export const memoryAdmits = (room: MemoryRoom | undefined, cost?: ExpectedCost): boolean =>
  !room || (ownAdmits(room, cost) && !stalled(room) && poolAdmits(room, cost));

/**
 * Issue #2499: the memory a machine has for new jobs now, over its floor: its own, or its host pool's when that is lower,
 * less what is kept for jobs started lately; none under memory pressure or after an OOM kill lately. It shrinks as this Decision places jobs there.
 */
function headroomOf(room: MemoryRoom): { bytes: number; floorBytes: number } {
  const own = room.availableBytes - room.keptBytes - room.floorBytes;
  const pool = room.pool ? room.pool.availableBytes - room.pool.keptBytes - room.pool.floorBytes : Infinity;
  const floorBytes = pool < own ? room.pool!.floorBytes : room.floorBytes;
  return { bytes: stalled(room) ? 0 : Math.max(0, Math.min(own, pool)), floorBytes };
}

export const memoryHeadroom = (room: MemoryRoom): number => headroomOf(room).bytes;

/** Issue #2499: how many more jobs of a job's memory the machine's memory holds now: its lane cap as its memory reads it. */
export const memoryLanes = (room: MemoryRoom): number => Math.floor(memoryHeadroom(room) / room.perJobBytes);

/** The Decision's note of what a machine's memory holds (issue #2499). */
export function headroomNote(id: string, room: MemoryRoom): string {
  const n = memoryLanes(room);
  const h = headroomOf(room);
  return `${id}: memory for ${n} more job${n === 1 ? '' : 's'} (${gib(h.bytes)} over its floor of ${gib(h.floorBytes)})`;
}

/** Issue #2499, lane tuning: how many jobs of a job's memory a machine's memory holds over its floor in all, and why. */
export interface MemoryLanes { lanes: number; why: string }

const jobsText = (n: number): string => `${n} job${n === 1 ? '' : 's'}`;

/**
 * Issue #2499: each machine's memory lanes, for lane tuning. Its own: its memory less its floor, over a job's memory. On a
 * host pool, also the kernel's memory less the pool's floor and a job's memory for each configured lane of its other
 * machines; the lower counts. A machine with no memory reading or a floor of 0 has none.
 */
export function memoryLaneCaps(machines: readonly MachineSnapshot[]): Map<string, MemoryLanes> {
  const own = machines.flatMap((machine) => { const f = ownFloor(machine); return f ? [{ machine, ...f }] : []; });
  const caps = new Map<string, MemoryLanes>();
  for (const { machine: m, r, floorBytes, perJobBytes } of own) {
    const lanes = Math.max(0, Math.floor((r.memTotalBytes - floorBytes) / perJobBytes));
    caps.set(m.id, { lanes, why: `its memory holds ${jobsText(lanes)}: ${gib(r.memTotalBytes)} less its floor of ${gib(floorBytes)}, at ${gib(perJobBytes)} a job` });
  }
  for (const members of poolsOf(own)) {
    const total = Math.max(...members.flatMap((s) => kernelOf(s.r).map((k) => k.total)));
    if (!Number.isFinite(total)) continue;
    for (const s of members) {
      const others = members.filter((o) => o.machine.id !== s.machine.id);
      const otherLanes = others.reduce((n, o) => n + (o.machine.configuredLanes ?? o.machine.maxLanes), 0);
      const otherBytes = others.reduce((n, o) => n + (o.machine.configuredLanes ?? o.machine.maxLanes) * o.perJobBytes, 0);
      const lanes = Math.max(0, Math.floor((total - kernelFloor(total) - otherBytes) / s.perJobBytes));
      if (lanes >= caps.get(s.machine.id)!.lanes) continue;
      const names = others.map((o) => o.machine.id).sort().join(', ');
      caps.set(s.machine.id, {
        lanes,
        why: `its host (shared with ${names}) holds ${jobsText(lanes)}: ${gib(total)} less its floor of ${gib(kernelFloor(total))} and ${gib(otherBytes)} for the ${otherLanes} lane${otherLanes === 1 ? '' : 's'} of ${names}, at ${gib(s.perJobBytes)} a job`,
      });
    }
  }
  return caps;
}

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
  if (ownAdmits(r, cost) && r.oomKillMs !== undefined) {
    return `its memory killed a process ${Math.round(r.oomKillMs / 60_000)} min ago (out of memory), and a new job starts only ${MEMORY_OOM_KILL_MS / 60_000} min after`;
  }
  if (ownAdmits(r, cost) && pressed10(r)) {
    return `its memory is under pressure: its tasks waited on memory ${Math.round(r.pressure!)}% of the last 10 s, and a new job starts only below ${MEMORY_PRESSURE_PERCENT}%`;
  }
  if (ownAdmits(r, cost) && pressed60(r)) {
    return `its memory is under pressure: its tasks waited on memory ${Math.round(r.pressure60!)}% of the last 60 s, and a new job starts only at ${MEMORY_PRESSURE_60_PERCENT}% or below`;
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
