// The usage limits editor's model (issue #522, design.md "Usage limits"): what a draft of the soft and hard
// limits may be, how a dragged limit moves, the band and lane cap a usage fraction gets at a draft, and the
// throttle line drawn under them. Pure: tested from test/ui/usage-limits.test.ts.
import type { UsageLimitPair, UsageSeries } from '../../../src/domain/types.ts';
import type { GraphPoint } from './usage-history.ts';

export type LimitName = keyof UsageLimitPair;
export type LimitBand = 'free' | 'soft' | 'hard';

/** A dragged limit moves in whole percents and stays this far from the other. */
const STEP = 0.01;

const inRange = (f: number) => Number.isFinite(f) && f >= 0 && f <= 1;

/** Why a draft cannot be saved, in the words the editor shows; undefined: it can. Mirrors the daemon's check. */
export function limitsProblem(l: UsageLimitPair): string | undefined {
  if (!inRange(l.soft) || !inRange(l.hard)) return 'Each limit is from 0% to 100%.';
  if (l.soft >= l.hard) return 'The soft limit must be below the hard limit.';
  return undefined;
}

const percent = (f: number) => Math.round(f * 100) / 100;

/** The draft with one limit moved to `to`: whole percents, within 0-100%, one percent short of the other limit. */
export function dragLimit(l: UsageLimitPair, which: LimitName, to: number): UsageLimitPair {
  const v = percent(Math.min(1, Math.max(0, to)));
  return which === 'soft'
    ? { soft: Math.min(v, percent(l.hard - STEP)), hard: l.hard }
    : { soft: l.soft, hard: Math.max(v, percent(l.soft + STEP)) };
}

/** The band a usage fraction is in at these limits (src/decider/usage.ts `laneCap`). */
export function bandAt(usedFrac: number, l: UsageLimitPair): LimitBand {
  if (usedFrac < l.soft) return 'free';
  return usedFrac >= l.hard ? 'hard' : 'soft';
}

/** The lane cap of an online machine at these limits: the decider's rule, which the UI may not import. */
export function capAt(maxLanes: number, usedFrac: number, l: UsageLimitPair): number {
  const band = bandAt(usedFrac, l);
  if (band === 'free') return maxLanes;
  if (band === 'hard') return 0;
  return Math.max(0, Math.floor((maxLanes * (l.hard - usedFrac)) / (l.hard - l.soft) + 1e-9));
}

/** The highest throttling line at each graph step: what the limits are measured against. Informational lines never throttle. */
export function throttleLine(series: readonly UsageSeries[]): GraphPoint[] {
  const max = new Map<number, number>();
  for (const s of series) {
    if (s.informational) continue;
    for (const p of s.points) {
      const t = Date.parse(p.at);
      max.set(t, Math.max(max.get(t) ?? 0, p.usedFrac));
    }
  }
  return [...max].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, v }));
}
