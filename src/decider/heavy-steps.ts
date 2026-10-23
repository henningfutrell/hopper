// The heavy-step gate's rule (issue #2622 part 3, design.md "The heavy-step gate"): admission counts a lane's memory when
// it opens, but a build's memory comes later, when the agent decides to build. So a heavy step (src/domain/heavy-steps.ts)
// runs only when its host's memory holds it: its machine, or the host pool its machine shares a kernel with. The first heavy
// step on a host always runs. Then a step runs while the memory available, less what the steps started lately keep and
// what it needs, stays at or above the floor; and a JVM build only while fewer run there than the host holds at their worst.
// Pure: the clock is `at`.
import { BUILD_WORST_GIB, type HeavyKind } from '../domain/heavy-steps.ts';
import type { MachineSnapshot } from '../domain/types.ts';
import { floorOf, gib, kernelFloor, kernelOf, poolsOf } from './memory-floor.ts';

const GIB = 1024 ** 3;
/** A heavy step that started less than this ago has not taken its memory yet: the reading does not show it. */
export const HEAVY_RAMP_MS = 2 * 60_000;

/** A heavy step that runs: its job, machine and kind, the memory it keeps, and when it got its slot. */
export interface HeavyStep { id: string; jobId: string; machineId: string; kind: HeavyKind; bytes: number; command: string; since: string }

/** The memory a heavy step counts against: one machine's, or one kernel's that a host pool shares. */
export interface HeavyHost { key: string; label: string; totalBytes: number; availableBytes: number; floorBytes: number }

/**
 * The host of `m`, among `all` the user's machines: its host pool's kernel when it has one (the same `bootId`), else the
 * machine itself. Undefined: no memory reading, or its memory floor is off.
 */
export function heavyHostOf(m: MachineSnapshot, all: readonly MachineSnapshot[], at: number): HeavyHost | undefined {
  const own = floorOf(m, at);
  if (!own || !m.resources) return undefined;
  const pool = poolsOf(all.filter((x) => floorOf(x, at)).map((machine) => ({ machine }))).find((p) => p.some((s) => s.machine.id === m.id));
  const kernels = pool?.flatMap(({ machine: { resources: r } }) => (r ? kernelOf(r) : [])) ?? [];
  if (!pool || !kernels.length) return { key: `machine:${m.id}`, label: m.id, totalBytes: m.resources.memTotalBytes, availableBytes: own.availableBytes, floorBytes: own.floorBytes };
  const windows = pool.flatMap(({ machine: { resources: r } }) => (r?.wsl && r.hostMemFreeBytes !== undefined ? [r.hostMemFreeBytes] : []));
  const total = Math.max(...kernels.map((k) => k.total));
  const others = pool.map((s) => s.machine.id).filter((id) => id !== m.id).sort();
  return {
    key: `boot:${m.resources.bootId}`, label: `host${others.length ? ` (shared with ${others.join(', ')})` : ''}`,
    totalBytes: total, availableBytes: Math.min(...kernels.map((k) => k.available), ...windows), floorBytes: kernelFloor(total),
  };
}

const steps = (n: number): string => `${n} heavy step${n === 1 ? '' : 's'}`;

/** Whether a heavy step of `kind`, which needs `needBytes`, runs now on `host`, where `held` run; else why it waits. */
export function heavyAdmits(host: HeavyHost, held: readonly HeavyStep[], kind: HeavyKind, needBytes: number, at: number): { ok: true } | { ok: false; reason: string } {
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
    reason: `${host.label} has ${gib(host.availableBytes)} available${lately.length ? `, ${gib(kept)} of it kept for ${steps(lately.length)} started lately` : ''}, and this step needs ${gib(needBytes)} over its floor of ${gib(host.floorBytes)}`,
  };
}
