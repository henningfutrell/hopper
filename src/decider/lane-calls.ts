// Decider calls in lane tuning (issue #688, design.md "Lane tuning", "Decider calls"): what Jev may pick at the
// `lane-count` and `job-machine` decision points, and what an applied pick changes. The rules stay the envelope: Jev
// picks a machine's lanes only from the lanes the rules allow, and a job's machine only from the machines the decider
// would place it on. Pure, like the rest of the decider.
import type { JevLanes, LaneRecommendation, MinorDecisionOption, PlacementPick } from '../domain/types.ts';

const lanesText = (n: number): string => `${n} lane${n === 1 ? '' : 's'}`;
const pct = (f: number): string => `${Math.round(f * 100)}%`;

/**
 * The lanes Jev may pick for a machine, fewest first: from one fewer than the lower of the configured and the
 * recommended lanes, to the higher of them — never past the headroom the rules found, since the rules recommend no more
 * —, within the machine's bounds. Fewer than two: nothing to pick.
 */
export function laneCountOptions(r: LaneRecommendation): MinorDecisionOption[] {
  const { minLanes, maxLanes } = r.tuning;
  const lo = Math.max(minLanes, Math.min(r.configured, r.lanes) - 1);
  const hi = Math.min(maxLanes, Math.max(r.configured, r.lanes));
  const options: MinorDecisionOption[] = [];
  for (let n = lo; n <= hi; n++) {
    const notes = [...(n === r.configured ? ['configured now'] : []), ...(n === r.lanes ? ['the rules recommend it'] : [])];
    options.push({ id: String(n), label: `${lanesText(n)}${notes.length ? ` (${notes.join('; ')})` : ''}` });
  }
  return options.length >= 2 ? options : [];
}

/**
 * The machine's recommendation with Jev's applied pick in place of the rules' own, while the rules still recommend what
 * they did when Jev was asked, at the same configured lanes; else the rules' recommendation as it is.
 */
export function withJevLanes(r: LaneRecommendation, jev: JevLanes | undefined): LaneRecommendation {
  if (!jev || jev.rulesLanes !== r.lanes || jev.configured !== r.configured || !r.tuning.autoTune || !r.online || r.headroom === undefined) return r;
  return {
    ...r, lanes: jev.lanes, confidence: jev.confidence, decidedBy: 'jev',
    reason: `Jev picked ${lanesText(jev.lanes)} at ${pct(jev.confidence)}; the rules: ${lanesText(r.lanes)}, ${r.reason}`,
    rules: { lanes: r.lanes, reason: r.reason, confidence: r.confidence },
  };
}

/**
 * Of the machines a job may go to, Jev's applied pick when it is one of them, with the words for the start reason; else
 * every one, no words: the pick is a preference, never a hold.
 */
export function jevPicked<S extends { machine: { id: string } }>(options: S[], pick: PlacementPick | undefined): { options: S[]; note?: string } {
  const chosen = pick && options.find((s) => s.machine.id === pick.machineId);
  return chosen ? { options: [chosen], note: `Jev picked ${pick.machineId} at ${pct(pick.confidence)}` } : { options };
}
