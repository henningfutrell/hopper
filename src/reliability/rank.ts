// Choosing the priority lanes (issue #535): the most reliable lanes with enough history on a machine online, as many
// as the count; a priority lane is replaced only by a lane better by more than the margin, so one failure does not
// move it; an admin's choice wins. Each lane says why it is, or is not, a priority lane. Pure.
import type { LaneId, LaneReliability, MachineId, PriorityLaneSettings, PriorityLaneView } from '../domain/types.ts';

/** How much more reliable (score, 0..1) a lane must be to take a priority lane's place. */
export const SWITCH_MARGIN = 0.1;

/** A lane a machine has: one of its lane numbers up to its lane count. */
export interface LaneSlot { laneId: LaneId; machineId: MachineId; online: boolean }

export interface Ranking {
  chosen: LaneId[];
  by: 'reliability' | 'manual' | 'none';
  lanes: PriorityLaneView[];
}

const percent = (x: number): string => `${Math.round(x * 100)}%`;
const lanes = (n: number): string => `${n === 1 ? 'the priority lane is' : `the ${n} priority lanes are`}`;

/** Most reliable first: score, then success, then the quicker start, then id. */
function byReliability(a: LaneReliability, b: LaneReliability): number {
  return b.score - a.score
    || (b.successRate ?? -1) - (a.successRate ?? -1)
    || (a.medianStartMs ?? Infinity) - (b.medianStartMs ?? Infinity)
    || a.laneId.localeCompare(b.laneId);
}

export function rank(o: { stats: readonly LaneReliability[]; slots: readonly LaneSlot[]; previous: readonly LaneId[]; settings: PriorityLaneSettings }): Ranking {
  const { settings } = o;
  const statOf = new Map(o.stats.map((s) => [s.laneId, s]));
  const all: LaneReliability[] = o.slots.map((slot) => statOf.get(slot.laneId) ?? {
    laneId: slot.laneId, machineId: slot.machineId, runs: 0, finished: 0, failed: 0, laneFaults: 0, recentFaults: 0, score: 0,
  });
  const online = new Map(o.slots.map((s) => [s.laneId, s.online]));
  const ranked = all.filter((s) => online.get(s.laneId) && s.runs >= settings.minRuns).sort(byReliability);
  const rankOf = new Map(ranked.map((s, i) => [s.laneId, i + 1]));
  const scoreOf = (id: LaneId): number => statOf.get(id)?.score ?? 0;

  let chosen: LaneId[];
  let by: Ranking['by'];
  const kept = new Set<LaneId>();
  if (settings.manual) {
    const known = new Set(o.slots.map((s) => s.laneId));
    chosen = settings.manual.filter((id) => known.has(id));
    by = 'manual';
  } else {
    const keep = ranked.filter((s) => o.previous.includes(s.laneId)).map((s) => s.laneId);
    const outside = (): LaneId[] => ranked.map((s) => s.laneId).filter((id) => !keep.includes(id));
    while (keep.length < settings.count && outside().length > 0) keep.push(outside()[0]!);
    for (;;) {
      const worst = [...keep].sort((a, b) => rankOf.get(b)! - rankOf.get(a)!)[0];
      const best = outside()[0];
      if (worst === undefined || best === undefined || scoreOf(best) <= scoreOf(worst) + SWITCH_MARGIN) break;
      keep.splice(keep.indexOf(worst), 1, best);
    }
    chosen = keep.sort((a, b) => rankOf.get(a)! - rankOf.get(b)!).slice(0, settings.count);
    for (const id of chosen) if (ranked.slice(0, chosen.length).every((s) => s.laneId !== id)) kept.add(id);
    by = chosen.length > 0 ? 'reliability' : 'none';
  }

  const isChosen = new Set(chosen);
  const reasonOf = (s: LaneReliability): string => {
    const r = rankOf.get(s.laneId);
    if (isChosen.has(s.laneId)) {
      if (by === 'manual') return 'priority lane: chosen by an admin';
      if (kept.has(s.laneId)) return `priority lane: rank ${r}, kept: within ${SWITCH_MARGIN * 100} points of rank ${r! - 1}, so the choice does not flap`;
      return `priority lane: rank ${r}, ${percent(s.score)} of ${s.runs} runs without a lane fault`;
    }
    if (!online.get(s.laneId)) return `not ranked: machine ${s.machineId} is offline`;
    if (r === undefined) return `not ranked: ${s.runs} of the ${settings.minRuns} runs needed in ${settings.windowDays} days`;
    if (by === 'manual') return `rank ${r}: an admin chose the priority lanes`;
    if (settings.count === 0) return `rank ${r}: priority lanes are off (count 0)`;
    const outranked = chosen.find((id) => rankOf.get(id)! > r);
    if (outranked) return `rank ${r}: better than priority lane ${outranked}, but not by more than ${SWITCH_MARGIN * 100} points`;
    return `rank ${r}: ${lanes(chosen.length)} more reliable`;
  };
  return {
    chosen, by,
    lanes: all.map((s) => ({ ...s, ...(rankOf.has(s.laneId) ? { rank: rankOf.get(s.laneId)! } : {}), priority: isChosen.has(s.laneId), reason: reasonOf(s) })),
  };
}
