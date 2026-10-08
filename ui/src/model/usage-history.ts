// The usage graph's model (issues #385, #502, design.md "Usage history"): its lines — one per account and
// usage window, however many machines read the account, named by account and window; one colour per account,
// a dash per window kind — their segments (a gap breaks a line), what hovering reads, and zooming: the stretch
// shown, narrowed or widened about a time or dragged across. Pure: tested from test/ui/usage-history.test.ts.
import type { UsageGraphPreset, UsageSeries, UsageTotalSeries } from '../../../src/domain/types.ts';

export const GRAPH_PRESETS: readonly UsageGraphPreset[] = ['24h', '3d', '7d', '30d'];

/** session solid, week dashed, informational dotted. */
export type LineDash = 'solid' | 'dashed' | 'dotted';
export const DASH_ARRAY: Record<LineDash, string | undefined> = { solid: undefined, dashed: '5 3', dotted: '1.5 3' };

/** One colour per account, in the order accounts first appear; past the last, they repeat. */
const ACCOUNT_COLORS = ['var(--busy)', 'var(--ok)', 'var(--warn)', 'var(--question)', 'var(--operator)', 'var(--bad)'] as const;

export interface GraphPoint { t: number; v: number }

export interface GraphLine {
  key: string;
  /** Account · window. */
  label: string;
  color: string;
  dash: LineDash;
  /** Informational lines start hidden: they limit one model, not every job. */
  shownByDefault: boolean;
  series: UsageSeries;
}

export const lineKey = (s: Pick<UsageSeries, 'account' | 'window'>): string => `${s.account}|${s.window ?? ''}`;

const dashOf = (s: UsageSeries): LineDash => (s.informational ? 'dotted' : /week/i.test(s.window ?? '') ? 'dashed' : 'solid');

const nameOf = (s: UsageSeries): string => (s.window ? `${s.account} · ${s.window}` : s.account);

/** The lines, in the order the series came (account, window). */
export function graphLines(series: readonly UsageSeries[]): GraphLine[] {
  const colors = new Map<string, string>();
  return series.map((s) => {
    if (!colors.has(s.account)) colors.set(s.account, ACCOUNT_COLORS[colors.size % ACCOUNT_COLORS.length]!);
    return { key: lineKey(s), label: nameOf(s), color: colors.get(s.account)!, dash: dashOf(s), shownByDefault: !s.informational, series: s };
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

/** A stretch of time shown, in ms. */
export interface Stretch { from: number; to: number }

/** The least stretch zooming in reaches: three hourly steps. */
export const MIN_ZOOM_MS = 3 * 3_600_000;

/** How far zooming may go: never past now, never wider than the history kept. */
export interface ZoomLimits { now: number; maxMs: number }

/** `s` as long as `span` (within the limits) with `at` where it was, moved back inside now and the history. */
function placed(s: Stretch, span: number, at: number, l: ZoomLimits): Stretch {
  const len = Math.min(Math.max(span, MIN_ZOOM_MS), l.maxMs);
  const share = s.to > s.from ? (at - s.from) / (s.to - s.from) : 0.5;
  let from = at - share * len;
  from = Math.max(Math.min(from, l.now - len), l.now - l.maxMs);
  return { from, to: from + len };
}

/** Zoomed by `factor` about `at` (below 1 in, above 1 out). */
export const zoomed = (s: Stretch, factor: number, at: number, l: ZoomLimits): Stretch => placed(s, (s.to - s.from) * factor, at, l);

/** The stretch dragged across from `a` to `b`, either way; a short one widens about its middle. */
export function selected(a: number, b: number, l: ZoomLimits): Stretch {
  const s = { from: Math.min(a, b), to: Math.max(a, b) };
  return placed(s, s.to - s.from, (s.from + s.to) / 2, l);
}

/** The instance usage totals as graph lines: one account, `all users` (and the unit, but for `%`), a line per unit and usage window. */
export const totalsAsSeries = (totals: readonly UsageTotalSeries[]): UsageSeries[] => totals.map((t) => ({
  account: t.unit === '%' ? 'all users' : `all users (${t.unit})`, ...(t.window !== undefined ? { window: t.window } : {}),
  informational: t.informational, unit: t.unit, points: t.points.map((p) => ({ at: p.at, usedFrac: p.usedFrac })), gaps: [], resets: [],
}));
