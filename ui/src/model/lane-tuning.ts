// Lane tuning in the UI (issue #688), pure: the line that compares a machine's recommended lanes with its configured
// lanes, the confidence, and the change a save of its settings sends.
import type { LaneRecommendation, LaneTuning } from './wire.ts';

/** The most lanes a bound may name, as the daemon allows it. */
const MAX_LANES = 64;

export interface LaneTuningDraft { autoTune: boolean; minLanes: string; maxLanes: string }
export type LaneTuningPatch = Partial<LaneTuning>;

const lanes = (n: number): string => `${n} lane${n === 1 ? '' : 's'}`;

/** The recommended lanes next to the configured lanes, in one line. */
export function recommendationLine(r: LaneRecommendation): string {
  if (!r.tuning.autoTune) return `Auto-tune is off: ${lanes(r.configured)} configured`;
  if (r.lanes === r.configured) return `Recommends the configured ${lanes(r.configured)}`;
  const d = r.lanes - r.configured;
  return `Recommends ${lanes(r.lanes)}; configured ${r.configured}: ${Math.abs(d)} ${d > 0 ? 'more' : 'fewer'}`;
}

export const confidenceText = (r: LaneRecommendation): string => (r.confidence > 0 ? `confidence ${Math.round(r.confidence * 100)}%` : 'no history yet');

function lanesOf(label: string, raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  const n = Number(text);
  return text !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_LANES ? { ok: true, value: n } : { ok: false, error: `${label}: a whole number from 0 to ${MAX_LANES}` };
}

/** The change a save sends: only what differs (undefined: nothing to save), or why the draft is refused. */
export function laneTuningPatch(t: LaneTuning, d: LaneTuningDraft): { ok: true; patch: LaneTuningPatch | undefined } | { ok: false; error: string } {
  const min = lanesOf('Least lanes', d.minLanes);
  if (!min.ok) return min;
  const max = lanesOf('Most lanes', d.maxLanes);
  if (!max.ok) return max;
  if (min.value > max.value) return { ok: false, error: 'The least lanes must not be more than the most lanes' };
  const patch: LaneTuningPatch = {
    ...(d.autoTune === t.autoTune ? {} : { autoTune: d.autoTune }),
    ...(min.value === t.minLanes ? {} : { minLanes: min.value }),
    ...(max.value === t.maxLanes ? {} : { maxLanes: max.value }),
  };
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : undefined };
}
