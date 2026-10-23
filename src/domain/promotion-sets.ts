// Promotion sets (issue #2554, design.md "Delivery forecasts"): the changes promoted together at one cutoff of a
// repository's schedule. A change that ends its landing checks before a cutoff is in that cutoff's set; at the cutoff or
// after it, in the next one. Set numbers count the cutoffs after the schedule's epoch. Cutoffs are wall-clock times in
// the schedule's time zone, so they keep their local time across daylight saving time. Pure.
import { offsetMs, zoned } from './zoned-time.ts';

export interface PromotionSetSchedule {
  /** An IANA time zone: the owner's. */
  timeZone: string;
  /** The cutoffs of each week: ISO weekday (1 Monday … 7 Sunday) and `HH:MM` local time. */
  cutoffs: readonly { weekday: number; time: string }[];
  /** From a set's cutoff to its end at the test gate. */
  testGateAfterMinutes: number;
  /** From a set's end at the test gate to its end in production. */
  productionAfterMinutes: number;
  /** Set 1 is the first cutoff after this time. */
  epoch: string;
  /** What an expedited change may do: go in a set of its own at once (`out_of_cadence`), or nothing (`none`). */
  expedite: 'out_of_cadence' | 'none';
}

export interface PromotionSet { set: number; cutoffAt: string; testGateAt: string; productionAt: string }

const DAY_LIMIT = 366;
const TIME = /^(\d{2}):(\d{2})$/;

/** The first cutoff strictly after `atMs`, as epoch ms; none within a year (no cutoffs). */
export function nextCutoff(s: PromotionSetSchedule, atMs: number): number | undefined {
  const times = s.cutoffs.flatMap((c) => {
    const m = TIME.exec(c.time);
    return m ? [{ weekday: c.weekday, h: Number(m[1]), mi: Number(m[2]) }] : [];
  }).sort((a, b) => a.h - b.h || a.mi - b.mi);
  if (times.length === 0) return undefined;
  const here = new Date(atMs + offsetMs(atMs, s.timeZone));
  for (let i = 0; i <= DAY_LIMIT; i++) {
    const day = new Date(Date.UTC(here.getUTCFullYear(), here.getUTCMonth(), here.getUTCDate() + i));
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    for (const t of times) {
      if (t.weekday !== weekday) continue;
      const c = zoned(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), t.h, t.mi, s.timeZone);
      if (c > atMs) return c;
    }
  }
  return undefined;
}

/** The set a change lands in when it is ready at `at`, and when the set is expected at the test gate and in production. */
export function promotionSetOf(s: PromotionSetSchedule, at: string): PromotionSet | undefined {
  const atMs = Date.parse(at);
  const epochMs = Date.parse(s.epoch);
  if (!(atMs >= epochMs)) return undefined;
  const cutoff = nextCutoff(s, atMs);
  if (cutoff === undefined) return undefined;
  let set = 0;
  for (let c = nextCutoff(s, epochMs); c !== undefined && c <= cutoff; c = nextCutoff(s, c)) set++;
  const testGate = cutoff + s.testGateAfterMinutes * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { set, cutoffAt: iso(cutoff), testGateAt: iso(testGate), productionAt: iso(testGate + s.productionAfterMinutes * 60_000) };
}

/** The most sets a lookup by number counts: about twenty years of two cutoffs a week. */
export const MAX_SET = 2000;

/** Set `n` of the schedule, and when it opens: at the cutoff of the set before it (set 1: at the epoch). */
export function promotionSetNumbered(s: PromotionSetSchedule, n: number): { set: PromotionSet; opensAt: string } | undefined {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SET) return undefined;
  let opens = Date.parse(s.epoch);
  let cutoff = nextCutoff(s, opens);
  for (let i = 1; i < n && cutoff !== undefined; i++) [opens, cutoff] = [cutoff, nextCutoff(s, cutoff)];
  if (cutoff === undefined) return undefined;
  const testGate = cutoff + s.testGateAfterMinutes * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { set: { set: n, cutoffAt: iso(cutoff), testGateAt: iso(testGate), productionAt: iso(testGate + s.productionAfterMinutes * 60_000) }, opensAt: iso(opens) };
}
