// Usage history and the usage graph (issue #385, design.md "Usage history"): every usage reading kept as a
// usage sample, the graph's range and step the user chose, and what the graph reads. Re-exported by types.ts.
import type { UsageReading } from './usage.ts';

/** A usage reading as kept in the usage history, with the account it was read for (its identity, when known). */
export interface UsageSample extends UsageReading {
  account?: string;
}

/** The graph range presets: a stretch ending now. */
export const USAGE_GRAPH_PRESETS = ['24h', '3d', '7d', '30d'] as const;
export type UsageGraphPreset = typeof USAGE_GRAPH_PRESETS[number];
export const PRESET_MS: Readonly<Record<UsageGraphPreset, number>> = { '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/** The graph steps: the time one point of the usage graph stands for. */
export const USAGE_GRAPH_STEPS = ['15m', '1h', '6h', '1d', '1w'] as const;
export type UsageGraphStep = typeof USAGE_GRAPH_STEPS[number];
export const STEP_MS: Readonly<Record<UsageGraphStep, number>> = { '15m': 900_000, '1h': 3_600_000, '6h': 6 * 3_600_000, '1d': 86_400_000, '1w': 7 * 86_400_000 };

/** The graph range: a preset ending now, or a fixed stretch (ISO times, `from` before `to`). */
export type UsageGraphRange = { preset: UsageGraphPreset } | { from: string; to: string };

/** What the usage graph shows: its range and its step. The user's, kept in their settings. */
export interface UsageGraphView {
  range: UsageGraphRange;
  step: UsageGraphStep;
}

export const DEFAULT_USAGE_GRAPH_VIEW: UsageGraphView = { range: { preset: '7d' }, step: '1h' };

/** How long usage samples are kept, in days, unless the user chose otherwise. */
export const DEFAULT_HISTORY_RETENTION_DAYS = 90;
export const MAX_HISTORY_RETENTION_DAYS = 3650;

/** One point of a usage graph line: the start of its graph step and the highest share of the limit used in it (0..1). */
export interface UsagePoint {
  at: string;
  usedFrac: number;
}

/** A stretch with no samples, far longer than the source reads: a failing or offline source. ISO times. */
export interface UsageGap {
  from: string;
  to: string;
}

/** One line of the usage graph: one usage source's usage window on one machine, over the graph range. */
export interface UsageSeries {
  source: string;
  machineId?: string;
  window?: string;
  informational: boolean;
  unit: string;
  /** The account its newest sample in the range was read for. */
  account?: string;
  points: UsagePoint[];
  gaps: UsageGap[];
  /** Where the usage window reset (ISO): the reset time a sample named, once a later sample names a later one. */
  resets: string[];
}

/** `GET /api/usage/history`: the usage graph of the request's user. */
export interface UsageHistory {
  view: UsageGraphView;
  /** The range resolved: ISO times. */
  from: string;
  to: string;
  stepMs: number;
  retentionDays: number;
  series: UsageSeries[];
}

/** One graph step of an instance usage total: the summed used over the summed limit, and how many lines it sums. */
export interface UsageTotalPoint extends UsagePoint {
  series: number;
}

/** Every user's lines of one unit and usage window, summed per graph step: nothing named. */
export interface UsageTotalSeries {
  unit: string;
  window?: string;
  informational: boolean;
  points: UsageTotalPoint[];
}

/** `GET /api/instance/usage-history`: the instance admin's usage graph, summed over every user. */
export interface InstanceUsageHistory {
  view: UsageGraphView;
  from: string;
  to: string;
  stepMs: number;
  totals: UsageTotalSeries[];
}
