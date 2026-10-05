import type { Lane, LanePlan, StartPlan } from '../domain/types.ts';
import type { MachineState } from './assign.ts';

/** Step 8: per-machine lane plan. `unassignedIdle` = idle lanes no start took. */
export function planLanes(
  s: MachineState, unassignedIdle: Lane[], lanes: Lane[], starts: StartPlan[], at: string, graceMs: number,
): LanePlan {
  const mine = lanes.filter((l) => l.machineId === s.machine.id);
  const opening = starts.filter((st) => st.machineId === s.machine.id && st.laneId === null).length;
  const target = Math.min(s.cap, s.occupied + s.assigned);

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

  // Newest busy lanes drain first. An executor past its own cap drains its own lanes (issue #140);
  // then the machine drains what is still past its cap.
  const draining = mine.filter((l) => l.state === 'draining');
  const busy = mine.filter((l) => l.state === 'busy').sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id));
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

/** Lanes stored for a machine no source lists any more (removed from plugins.yaml): close the idle, drain the busy. */
export function planGoneLanes(machineId: string, lanes: Lane[]): LanePlan {
  const mine = lanes.filter((l) => l.machineId === machineId);
  const close = mine.filter((l) => l.state === 'idle').map((l) => l.id).sort();
  const drain = mine.filter((l) => l.state === 'busy').map((l) => l.id).sort();
  const reason = `${machineId}: no longer configured; close ${close.length}, drain ${drain.length}`;
  return { machineId, current: mine.length, target: 0, open: 0, close, drain, reason };
}
