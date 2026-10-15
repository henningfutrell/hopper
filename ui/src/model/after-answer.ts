// How the work after each person's act spent its time (issue #1194), as Sources shows it: per act, its wait on its queue
// apart from its run (GET /api/sources `afterAnswer`). Pure; the view renders it.
import type { AfterAnswerTiming, TimingSpread } from './wire.ts';

export interface AfterAnswerRow {
  key: string;
  /** The act, and the source whose own work it is (an intake action's GitHub writes). */
  name: string;
  count: number;
  wait: TimingSpread;
  run: TimingSpread;
  lastAt: string;
}

/** A time in ms under a second, else in seconds. */
export const ms = (n: number): string => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

/** The slowest work first, by the p95 of its wait and its run together. */
export function afterAnswerRows(timings: readonly AfterAnswerTiming[]): AfterAnswerRow[] {
  return timings
    .map((t) => ({
      key: `${t.source ?? ''}/${t.act}`, name: t.source ? `${t.act} · ${t.source}` : t.act,
      count: t.count, wait: t.waitMs, run: t.runMs, lastAt: t.lastAt,
    }))
    .sort((a, b) => b.wait.p95 + b.run.p95 - (a.wait.p95 + a.run.p95) || a.name.localeCompare(b.name));
}
