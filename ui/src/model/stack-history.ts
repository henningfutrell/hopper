// The stack's resource graph's model (issue #947, design.md "Stack resources over time"): a line per service and metric,
// named `<service> · <metric>`, drawn by the usage graph (charts/usage-history.tsx) on the Resources page — a colour per
// service, in the order services first appear, and a dash per metric; a sandbox box's lines hidden until shown, since
// boxes come and go. Pure: tested from test/ui/stack-history.test.ts.
import type { StackMetric, StackSeries, UsageSeries } from '../../../src/domain/types.ts';
import { ACCOUNT_COLORS, type GraphLine, type LineDash } from './usage-history.ts';

export const METRIC_NAMES: Readonly<Record<StackMetric, string>> = { cpu: 'CPU', memory: 'memory', connections: 'connections', 'check-errors': 'failed checks' };
const METRIC_DASH: Readonly<Record<StackMetric, LineDash>> = { cpu: 'solid', memory: 'dashed', connections: 'dotted', 'check-errors': 'dotted' };

/** A stack line as the usage graph draws one: its points are shares, 0..1, as a usage window's are. */
const asUsage = (s: StackSeries): UsageSeries =>
  ({ account: s.service, window: METRIC_NAMES[s.metric], informational: false, unit: '%', points: s.points, gaps: s.gaps, resets: [] });

export function stackLines(series: readonly StackSeries[]): GraphLine[] {
  const colors = new Map<string, string>();
  return series.map((s) => {
    if (!colors.has(s.service)) colors.set(s.service, ACCOUNT_COLORS[colors.size % ACCOUNT_COLORS.length]!);
    return {
      key: `${s.service}|${s.metric}`, label: `${s.service} · ${METRIC_NAMES[s.metric]}`, color: colors.get(s.service)!,
      dash: METRIC_DASH[s.metric], shownByDefault: s.group !== 'sandbox', series: asUsage(s),
    };
  });
}
