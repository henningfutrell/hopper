// The usage graph's model (issue #385, design.md "Usage history"): its lines — one per usage source,
// machine and usage window, named by account and window; one colour per account, a dash per window kind —
// their segments (a gap breaks a line), and what hovering reads. Pure: tested from test/ui/usage-history.test.ts.
import type { UsageGraphPreset, UsageGraphStep, UsageSeries, UsageTotalSeries } from '../../../src/domain/types.ts';

export const GRAPH_PRESETS: readonly UsageGraphPreset[] = ['24h', '3d', '7d', '30d'];
export const GRAPH_STEPS: readonly { step: UsageGraphStep; label: string }[] = [
  { step: '15m', label: '15 min' }, { step: '1h', label: 'hour' }, { step: '6h', label: '6 hours' }, { step: '1d', label: 'day' }, { step: '1w', label: 'week' },
];

/** session solid, week dashed, informational dotted. */
export type LineDash = 'solid' | 'dashed' | 'dotted';
export const DASH_ARRAY: Record<LineDash, string | undefined> = { solid: undefined, dashed: '5 3', dotted: '1.5 3' };

/** One colour per account, in the order accounts first appear; past the last, they repeat. */
const ACCOUNT_COLORS = ['var(--busy)', 'var(--ok)', 'var(--warn)', 'var(--question)', 'var(--operator)', 'var(--bad)'] as const;

export interface GraphPoint { t: number; v: number }

export interface GraphLine {
  key: string;
  /** Account (else source, and machine) · window. */
  label: string;
  color: string;
  dash: LineDash;
  /** Informational lines start hidden: they limit one model, not every job. */
  shownByDefault: boolean;
  series: UsageSeries;
}

export const lineKey = (s: Pick<UsageSeries, 'source' | 'machineId' | 'window'>): string => `${s.source}|${s.machineId ?? ''}|${s.window ?? ''}`;
const accountKey = (s: UsageSeries): string => `${s.source}|${s.machineId ?? ''}`;

const dashOf = (s: UsageSeries): LineDash => (s.informational ? 'dotted' : /week/i.test(s.window ?? '') ? 'dashed' : 'solid');

function nameOf(s: UsageSeries): string {
  const who = s.account ?? (s.machineId ? `${s.source} (${s.machineId})` : s.source);
  return s.window ? `${who} · ${s.window}` : who;
}

/** The lines, in the order the series came (source, machine, window). */
export function graphLines(series: readonly UsageSeries[]): GraphLine[] {
  const colors = new Map<string, string>();
  return series.map((s) => {
    const account = accountKey(s);
    if (!colors.has(account)) colors.set(account, ACCOUNT_COLORS[colors.size % ACCOUNT_COLORS.length]!);
    return { key: lineKey(s), label: nameOf(s), color: colors.get(account)!, dash: dashOf(s), shownByDefault: !s.informational, series: s };
  });
}

/**
 * The line in pieces: two points join unless a gap lies between them — a stretch the source gave nothing
 * for, past the end of the first point's step and up to the second's start. A step with no sample but no
 * gap (a source that reads less often than the step) joins.
 */
export function lineSegments(s: UsageSeries, stepMs: number): GraphPoint[][] {
  const gaps = s.gaps.map((g) => ({ from: Date.parse(g.from), to: Date.parse(g.to) }));
  const out: GraphPoint[][] = [];
  let prev: GraphPoint | undefined;
  for (const p of s.points) {
    const point = { t: Date.parse(p.at), v: p.usedFrac };
    const broken = prev !== undefined && gaps.some((g) => g.from < point.t && g.to > prev!.t + stepMs);
    if (!prev || broken) out.push([point]);
    else out.at(-1)!.push(point);
    prev = point;
  }
  return out;
}

/** Each shown line's value in the step under `t`: a line with no point in that step has none. */
export function valuesAt(lines: readonly GraphLine[], t: number, stepMs: number, hidden: ReadonlySet<string>): { key: string; v: number }[] {
  return lines.flatMap((l) => {
    if (hidden.has(l.key)) return [];
    const p = l.series.points.find((x) => { const at = Date.parse(x.at); return at <= t && t < at + stepMs; });
    return p ? [{ key: l.key, v: p.usedFrac }] : [];
  });
}

/** The lines hidden: those the legend hid (`toggled` true), and the informational ones it did not show. */
export const hiddenLines = (lines: readonly GraphLine[], toggled: ReadonlyMap<string, boolean>): Set<string> =>
  new Set(lines.filter((l) => toggled.get(l.key) ?? !l.shownByDefault).map((l) => l.key));

/** `2026-10-01T09:00` in the viewer's time, for a datetime-local input; and back to ISO. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | undefined => { const ms = Date.parse(v); return Number.isNaN(ms) ? undefined : new Date(ms).toISOString(); };

/** The instance usage totals as graph lines: one account, `all users`, a line per unit and usage window. */
export const totalsAsSeries = (totals: readonly UsageTotalSeries[]): UsageSeries[] => totals.map((t) => ({
  source: 'all users', ...(t.unit === '%' ? {} : { machineId: t.unit }), ...(t.window !== undefined ? { window: t.window } : {}),
  informational: t.informational, unit: t.unit, points: t.points.map((p) => ({ at: p.at, usedFrac: p.usedFrac })), gaps: [], resets: [],
}));
