import type { HoldPlan, JobId, Lane, LanePlan, StartPlan, WaitPlan } from '../domain/types.ts';
import { NO_NEW_JOB, homeless, unpinnedCap, type MachineState } from './assign.ts';
import { freePriority, priorityLaneNames } from './priority-lanes.ts';

/**
 * Step 8: per-machine lane plan. `unassignedIdle` = idle lanes no start took. `priorityOf`: the running jobs'
 * priorities — the lowest-priority busy lane drains first, high-priority work last (issue #535).
 */
export function planLanes(
  s: MachineState, unassignedIdle: Lane[], lanes: Lane[], starts: StartPlan[], at: string, graceMs: number, priorityOf: ReadonlyMap<JobId, number> = new Map(),
): LanePlan {
  const mine = lanes.filter((l) => l.machineId === s.machine.id);
  const opening = starts.filter((st) => st.machineId === s.machine.id && st.laneId === null).length;
  // A critical job's lane over the cap counts (issue #373): it drains when that job ends, not now.
  const target = Math.min(s.cap + s.overCap, s.occupied + s.assigned);

  const now = Date.parse(at);
  const idleFor = (l: Lane): number => (l.idleSince ? now - Date.parse(l.idleSince) : Infinity);
  // Freshest idle lanes first: they are the ones worth keeping.
  const candidates = [...unassignedIdle].sort((a, b) => idleFor(a) - idleFor(b) || a.id.localeCompare(b.id));
  const close: string[] = [];
  let kept = 0;
  for (const l of candidates) {
    if (s.occupied + s.assigned + kept < s.cap && idleFor(l) < graceMs) kept += 1;
    else close.push(l.id);
  }

  // The lowest-priority busy lanes drain first (issue #535), the newest of them first. An executor past its own cap
  // drains its own lanes (issue #140); then the machine drains what is still past its cap.
  const draining = mine.filter((l) => l.state === 'draining');
  const priority = (l: Lane): number => (l.jobId === undefined ? -Infinity : priorityOf.get(l.jobId) ?? -Infinity);
  const busy = mine.filter((l) => l.state === 'busy')
    .sort((a, b) => priority(a) - priority(b) || b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id));
  const drained = new Set<string>();
  for (const e of s.executors.values()) {
    const excess = e.occupied.length - draining.filter((l) => e.occupied.includes(l.id)).length - e.cap;
    for (const l of busy.filter((b) => e.occupied.includes(b.id)).slice(0, Math.max(0, excess))) drained.add(l.id);
  }
  const toDrain = Math.max(0, s.occupied - target - draining.length - drained.size);
  for (const l of busy.filter((b) => !drained.has(b.id)).slice(0, toDrain)) drained.add(l.id);
  const drain = busy.filter((l) => drained.has(l.id)).map((l) => l.id);

  const reason = `${s.machine.id}: cap ${s.cap} (${s.band}), occupied ${s.occupied}, starting ${s.assigned}`
    + `; open ${opening}, close ${close.length}, drain ${drain.length}, keep ${kept}`;
  return { machineId: s.machine.id, current: mine.length, target, open: opening, close, drain, reason };
}

/** Lanes stored for a machine no source lists any more (removed from the plugins config): close the idle, drain the busy. */
export function planGoneLanes(machineId: string, lanes: Lane[]): LanePlan {
  const mine = lanes.filter((l) => l.machineId === machineId);
  const close = mine.filter((l) => l.state === 'idle').map((l) => l.id).sort();
  const drain = mine.filter((l) => l.state === 'busy').map((l) => l.id).sort();
  const reason = `${machineId}: no longer configured; close ${close.length}, drain ${drain.length}`;
  return { machineId, current: mine.length, target: 0, open: 0, close, drain, reason };
}

const jobs = (n: number): string => `${n} job${n === 1 ? '' : 's'}`;

/**
 * Why a machine leaves lanes unused after this Decision (issue #440), or undefined when it uses them all. The
 * machine's own state comes first (it cannot take work), then its lane cap (usage pacing, reserved lanes),
 * then the queue (jobs that cannot run here, held jobs, none waiting).
 */
export function idleReason(s: MachineState, hold: readonly HoldPlan[], wait: readonly WaitPlan[]): string | undefined {
  const m = s.machine;
  if (m.maxLanes === 0) return 'no lanes: the machine\'s lane count is 0';
  const used = s.occupied + s.assigned;
  if (used >= m.maxLanes) return undefined;
  if (!m.online) return 'machine offline';
  if (homeless(m)) return 'its home is not known yet: no job is placed there';
  if (m.disk?.low) return `disk low: ${NO_NEW_JOB}`;
  if (used >= s.cap) return `usage pacing: lane cap ${s.cap} of ${m.maxLanes} (${s.band}${s.band === 'soft' || s.band === 'hard' ? `, used ${Math.round(s.usedFrac * 100)}%` : ''})`;
  if (wait.length > 0 && s.unpinned >= unpinnedCap(s) && (m.reservedLanes ?? 0) > 0) {
    const kept = m.reservedLanes!;
    return `reserved: ${kept} lane${kept === 1 ? '' : 's'} kept for jobs pinned to this machine`;
  }
  const kept = freePriority(s.slots);
  if (wait.length > 0 && kept.length > 0) return `${priorityLaneNames(kept)} kept free for high-priority jobs`;
  if (wait.length > 0) return 'no waiting job can run here (its executor, its pin, or an executor\'s lane cap)';
  if (hold.length > 0) {
    const first = hold[0]!.reason;
    return `every waiting job is held: ${first} (${jobs(hold.length)}${hold.some((h) => h.reason !== first) ? ', for several reasons' : ''})`;
  }
  return 'no job waiting';
}
