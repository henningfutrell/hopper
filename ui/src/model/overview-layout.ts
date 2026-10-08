// The overview layout (issue #73): which overview panels show, in what order, how wide (thirds of
// the row), and each panel's settings. The viewer's, kept per browser (hooks/use-overview-layout.ts).
// The viewer rearranges it as they see fit (issue #86): movePanel steps, placePanel drops.
// Pure: reading a stored layout never throws and never loses a panel — a field it cannot use takes
// its default, a panel it does not know goes, a panel the stored layout lacks comes back at the end.

export const PANEL_IDS = ['kpis', 'timeline', 'attention', 'lanes', 'waiting', 'ended', 'throughput', 'usage', 'usageHistory', 'live'] as const;
export type PanelId = typeof PANEL_IDS[number];

export const PANEL_TITLES: Record<PanelId, string> = {
  kpis: 'Numbers', timeline: 'Lane timeline', attention: 'Attention', lanes: 'Lanes', waiting: 'Waiting',
  ended: 'Ended', throughput: 'Ended per hour', usage: 'Usage', usageHistory: 'Usage over time', live: 'Live activity',
};

/** Thirds of the overview's row; on a narrow screen every panel takes the whole row. */
export const PANEL_WIDTHS = [1, 2, 3] as const;
export type PanelWidth = typeof PANEL_WIDTHS[number];
export const WIDTH_NAMES: Record<PanelWidth, string> = { 1: 'One third', 2: 'Two thirds', 3: 'Full width' };

export interface PanelPlacement { id: PanelId; shown: boolean; width: PanelWidth }

export const TIMELINE_WINDOWS = ['1h', '6h', '24h'] as const;
export type TimelineWindow = typeof TIMELINE_WINDOWS[number];
/** The job store holds the last 24 h of ended jobs: no longer chart is possible. */
export const THROUGHPUT_HOURS = [6, 12, 24] as const;
export const LIVE_EVENTS = [5, 10, 14, 25, 50] as const;

export interface OverviewSettings {
  timelineWindow: TimelineWindow;
  throughputHours: typeof THROUGHPUT_HOURS[number];
  liveEvents: typeof LIVE_EVENTS[number];
  /** The usage source the Usage panel shows when there are several (issue #85); absent = the first. */
  usageSource?: string;
}

export interface OverviewLayout { panels: PanelPlacement[]; settings: OverviewSettings }

const WIDTH: Record<PanelId, PanelWidth> = { kpis: 3, timeline: 2, attention: 1, lanes: 1, waiting: 1, ended: 1, throughput: 2, usage: 1, usageHistory: 3, live: 3 };

export const DEFAULT_LAYOUT: OverviewLayout = {
  panels: PANEL_IDS.map((id) => ({ id, shown: true, width: WIDTH[id] })),
  settings: { timelineWindow: '1h', throughputHours: 24, liveEvents: 14 },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T>(options: readonly T[], v: unknown, fallback: T): T => options.includes(v as T) ? v as T : fallback;

function placementOf(v: Record<string, unknown>, id: PanelId): PanelPlacement {
  return { id, shown: typeof v.shown === 'boolean' ? v.shown : true, width: oneOf(PANEL_WIDTHS, v.width, WIDTH[id]) };
}

/** The layout a browser stored (`null`: nothing stored). */
export function parseLayout(text: string | null): OverviewLayout {
  if (text === null) return DEFAULT_LAYOUT;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return DEFAULT_LAYOUT; }
  if (!isRecord(raw)) return DEFAULT_LAYOUT;
  const seen = new Set<PanelId>();
  const panels: PanelPlacement[] = [];
  for (const p of Array.isArray(raw.panels) ? raw.panels : []) {
    if (!isRecord(p) || !PANEL_IDS.includes(p.id as PanelId) || seen.has(p.id as PanelId)) continue;
    seen.add(p.id as PanelId);
    panels.push(placementOf(p, p.id as PanelId));
  }
  for (const p of DEFAULT_LAYOUT.panels) if (!seen.has(p.id)) panels.push(p);
  const s = isRecord(raw.settings) ? raw.settings : {};
  const d = DEFAULT_LAYOUT.settings;
  return {
    panels,
    settings: {
      timelineWindow: oneOf(TIMELINE_WINDOWS, s.timelineWindow, d.timelineWindow),
      throughputHours: oneOf(THROUGHPUT_HOURS, s.throughputHours, d.throughputHours),
      liveEvents: oneOf(LIVE_EVENTS, s.liveEvents, d.liveEvents),
      ...(typeof s.usageSource === 'string' && s.usageSource ? { usageSource: s.usageSource } : {}),
    },
  };
}

/** Swaps the panel with its neighbour before (-1) or after (1); at either end it stays. */
export function movePanel(l: OverviewLayout, id: PanelId, by: -1 | 1): OverviewLayout {
  const i = l.panels.findIndex((p) => p.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= l.panels.length) return l;
  const panels = [...l.panels];
  [panels[i], panels[j]] = [panels[j]!, panels[i]!];
  return { ...l, panels };
}

export function setPanel(l: OverviewLayout, id: PanelId, patch: Partial<Omit<PanelPlacement, 'id'>>): OverviewLayout {
  return { ...l, panels: l.panels.map((p) => p.id === id ? { ...p, ...patch } : p) };
}

export function setSetting<K extends keyof OverviewSettings>(l: OverviewLayout, key: K, value: OverviewSettings[K]): OverviewLayout {
  return { ...l, settings: { ...l.settings, [key]: value } };
}

/** The panel dropped on another takes its place (issue #86): in front of it when it came from
 *  after, behind it when it came from before. Dropped on itself or on an unknown panel, it stays. */
export function placePanel(l: OverviewLayout, id: PanelId, at: PanelId): OverviewLayout {
  const i = l.panels.findIndex((p) => p.id === id);
  const j = l.panels.findIndex((p) => p.id === at);
  if (i < 0 || j < 0 || i === j) return l;
  const panels = l.panels.filter((p) => p.id !== id);
  panels.splice(j, 0, l.panels[i]!);
  return { ...l, panels };
}
