// The heavy-step gate's rule (issue #2622 part 3, design.md "The heavy-step gate"): admission counts a lane's memory when
// it opens, but a build's memory comes later, when the agent decides to build. So a heavy step (src/domain/heavy-steps.ts)
// runs only when its host's memory holds it: its machine, or the host pool its machine shares a kernel with. The first heavy
// step on a host always runs. Then a step runs while the memory available, less what the steps started lately keep and
// what it needs, stays at or above the floor; and a JVM build only while fewer run there than the host holds at their worst.
// Part 5, the shed: under memory pressure (`heavyPressure`) no heavy step starts, and the newest one that runs is paused
// until the pressure clears (`heavyShed`). Pure: the clock is `at`.
import { BUILD_WORST_GIB, type HeavyKind } from '../domain/heavy-steps.ts';
import { MEMORY_PRESSURE_60_PERCENT, type MachineSnapshot, type ResourceReading } from '../domain/types.ts';
import { floorOf, gib, kernelFloor, kernelOf, poolsOf } from './memory-floor.ts';

const GIB = 1024 ** 3;
/** A heavy step that started less than this ago has not taken its memory yet: the reading does not show it. */
export const HEAVY_RAMP_MS = 2 * 60_000;
/** Part 5: a host is under pressure with less than this available (a quarter of its memory on a small one), */
export const HEAVY_SHED_AVAILABLE_GIB = 2;
/** or with its swap used over this share, in percent, while some task waits on memory (PSI `some` avg60 at 1% or more). */
export const HEAVY_SHED_SWAP_PERCENT = 50;
/** The shed pauses, or lets run again, at most one step a host in this time: the readings show what the last change did. */
export const HEAVY_SHED_EVERY_MS = 30_000;

/**
 * A heavy step that runs: its job, machine and kind, the memory it keeps (`recorded`: its repository's peak, part 4), when
 * it got its slot, and since when the shed paused it (part 5).
 */
export interface HeavyStep { id: string; jobId: string; machineId: string; kind: HeavyKind; bytes: number; recorded?: boolean; command: string; since: string; paused?: string }

/**
 * The memory a heavy step counts against: one machine's, or one kernel's that a host pool shares. `someAvg60` and the swap
 * (part 5): the most of its machines' readings; absent, not read.
 */
export interface HeavyHost {
  key: string; label: string; totalBytes: number; availableBytes: number; floorBytes: number;
  someAvg60?: number; swapUsedBytes?: number; swapTotalBytes?: number;
}

/** Part 5: the memory pressure signals of the readings of a host's machines, the most of each. */
function signalsOf(rs: readonly (ResourceReading | undefined)[]): Pick<HeavyHost, 'someAvg60' | 'swapUsedBytes' | 'swapTotalBytes'> {
  const psi = rs.flatMap((r) => (r?.memPressure?.someAvg60 !== undefined ? [r.memPressure.someAvg60] : []));
  const swap = rs.flatMap((r) => (r?.swapTotalBytes && r.swapUsedBytes !== undefined ? [{ used: r.swapUsedBytes, total: r.swapTotalBytes }] : []))
    .sort((a, b) => b.used / b.total - a.used / a.total)[0];
  return { ...(psi.length ? { someAvg60: Math.max(...psi) } : {}), ...(swap ? { swapUsedBytes: swap.used, swapTotalBytes: swap.total } : {}) };
}

/**
 * The host of `m`, among `all` the user's machines: its host pool's kernel when it has one (the same `bootId`), else the
 * machine itself. Undefined: no memory reading, or its memory floor is off.
 */
export function heavyHostOf(m: MachineSnapshot, all: readonly MachineSnapshot[], at: number): HeavyHost | undefined {
  const own = floorOf(m, at);
  if (!own || !m.resources) return undefined;
  const pool = poolsOf(all.filter((x) => floorOf(x, at)).map((machine) => ({ machine }))).find((p) => p.some((s) => s.machine.id === m.id));
  const kernels = pool?.flatMap(({ machine: { resources: r } }) => (r ? kernelOf(r) : [])) ?? [];
  if (!pool || !kernels.length) {
    return { key: `machine:${m.id}`, label: m.id, totalBytes: m.resources.memTotalBytes, availableBytes: own.availableBytes, floorBytes: own.floorBytes, ...signalsOf([m.resources]) };
  }
  const windows = pool.flatMap(({ machine: { resources: r } }) => (r?.wsl && r.hostMemFreeBytes !== undefined ? [r.hostMemFreeBytes] : []));
  const total = Math.max(...kernels.map((k) => k.total));
  const others = pool.map((s) => s.machine.id).filter((id) => id !== m.id).sort();
  return {
    key: `boot:${m.resources.bootId}`, label: `host${others.length ? ` (shared with ${others.join(', ')})` : ''}`,
    totalBytes: total, availableBytes: Math.min(...kernels.map((k) => k.available), ...windows), floorBytes: kernelFloor(total),
    ...signalsOf(pool.map((s) => s.machine.resources)),
  };
}

const steps = (n: number): string => `${n} heavy step${n === 1 ? '' : 's'}`;

/**
 * Whether a heavy step of `kind`, which needs `needBytes` (`recorded`: its repository's recorded peak, part 4), runs now on
 * `host`, where `held` run; else why it waits.
 */
export function heavyAdmits(host: HeavyHost, held: readonly HeavyStep[], kind: HeavyKind, needBytes: number, at: number, recorded = false): { ok: true } | { ok: false; reason: string } {
  const pressure = heavyPressure(host);
  if (pressure) return { ok: false, reason: `${pressure}; a heavy step starts when it clears` };
  if (held.some((s) => s.paused)) return { ok: false, reason: `${host.label} has a heavy step paused for memory pressure; a heavy step starts when it runs again` };
  if (kind === 'build') {
    const cap = Math.max(1, Math.floor((host.totalBytes - host.floorBytes) / (BUILD_WORST_GIB * GIB)));
    const builds = held.filter((s) => s.kind === 'build').length;
    if (builds >= cap) {
      return {
        ok: false,
        reason: `${host.label} runs ${builds} JVM build${builds === 1 ? '' : 's'}, and holds at most ${cap} at once: ${gib(host.totalBytes)} less its floor of ${gib(host.floorBytes)}, at up to ${BUILD_WORST_GIB} GiB a build`,
      };
    }
  }
  if (!held.length) return { ok: true };
  const lately = held.filter((s) => at - Date.parse(s.since) < HEAVY_RAMP_MS);
  const kept = lately.reduce((n, s) => n + s.bytes, 0);
  if (host.availableBytes - kept - needBytes >= host.floorBytes) return { ok: true };
  return {
    ok: false,
    reason: `${host.label} has ${gib(host.availableBytes)} available${lately.length ? `, ${gib(kept)} of it kept for ${steps(lately.length)} started lately` : ''}, and this step needs ${gib(needBytes)}${recorded ? ' (its repository\'s recorded peak)' : ''} over its floor of ${gib(host.floorBytes)}`,
  };
}

const pct = (n: number): string => `${Math.round(n)}%`;

/**
 * Part 5: why `host` is under memory pressure, or undefined: less than HEAVY_SHED_AVAILABLE_GIB available (a quarter of its
 * memory on a small one); its tasks waited on memory over MEMORY_PRESSURE_60_PERCENT of the last 60 s; or its swap used over
 * HEAVY_SHED_SWAP_PERCENT while some task waits on memory. Swap used with no task waiting is no pressure: Linux reads swapped
 * memory back only when it is used, so the swap stays full after a burst.
 */
export function heavyPressure(host: HeavyHost): string | undefined {
  const under = `${host.label} is under memory pressure`;
  const floor = Math.min(HEAVY_SHED_AVAILABLE_GIB * GIB, host.totalBytes / 4);
  if (host.availableBytes < floor) return `${under}: ${gib(host.availableBytes)} available, under ${gib(floor)}`;
  const psi = host.someAvg60;
  if (psi !== undefined && psi > MEMORY_PRESSURE_60_PERCENT) return `${under}: its tasks waited on memory ${pct(psi)} of the last 60 s, over ${MEMORY_PRESSURE_60_PERCENT}%`;
  const swap = host.swapTotalBytes ? ((host.swapUsedBytes ?? 0) * 100) / host.swapTotalBytes : 0;
  if (swap > HEAVY_SHED_SWAP_PERCENT && psi !== undefined && psi >= 1) return `${under}: its swap is ${pct(swap)} used, over ${HEAVY_SHED_SWAP_PERCENT}%, and its tasks wait on memory`;
  return undefined;
}

const bySince = (a: HeavyStep, b: HeavyStep): number => a.since.localeCompare(b.since) || a.id.localeCompare(b.id);

/**
 * Part 5, the shed: under pressure, pause the newest of the `held` steps on `host` that run, but never the last one that
 * runs, so the oldest step goes on and frees its memory; with no pressure, let the paused step that started first run
 * again. At most one change each HEAVY_SHED_EVERY_MS after the host's last (`lastChange`). Undefined: no change.
 */
export function heavyShed(host: HeavyHost, held: readonly HeavyStep[], at: number, lastChange?: number): { pause: string; reason: string } | { resume: string } | undefined {
  if (lastChange !== undefined && at - lastChange < HEAVY_SHED_EVERY_MS) return undefined;
  const pressure = heavyPressure(host);
  const running = held.filter((s) => !s.paused).sort(bySince);
  if (pressure) return running.length >= 2 ? { pause: running.at(-1)!.id, reason: `${pressure}: the newest heavy step is paused until it clears` } : undefined;
  const paused = held.filter((s) => s.paused).sort(bySince)[0];
  return paused ? { resume: paused.id } : undefined;
}
