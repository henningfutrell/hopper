// A usage graph in a panel (issues #385, #502): the lines over the stretch shown — a range preset ending now, or
// a stretch zoomed to — at the graph step the hopper picks for it, and a legend that names each line and
// toggles it. Zoom in and out by the buttons, a pinch, Ctrl/⌘ + scroll, or a drag across; Reset goes back
// to the preset. New samples redraw it as the stream tells of them (SSE usage.recorded), and once a minute
// besides. The Overview's shows the user's own accounts and saves the preset for them; Settings → Users
// shows the instance admin the lines summed over every user. The resource graphs (issue #560) use it too, with
// their own lines (`linesOf`), redrawn as the stream tells of new machine samples (SSE machine.recorded).
import { useCallback, useMemo, useState } from 'react';
import { LineChart, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Empty, Panel } from '@/components/panel';
import { LineSwatch, UsageGraph } from '@/charts/usage-history';
import { usePoll } from '@/hooks/use-poll';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { GRAPH_PRESETS, graphLines, hiddenLines, zoomed, type GraphLine, type Stretch } from '@/model/usage-history';
import type { UsageGraphView, UsageSeries } from '@/model/wire';
import { useHopper } from '@/store';

const tz = () => -new Date().getTimezoneOffset();
const DAY = 86_400_000;
/** How far back zooming out goes when the read does not say how long the history is kept. */
const DEFAULT_KEPT_DAYS = 90;

/** What either usage graph read answers. */
export interface GraphData { view: UsageGraphView; from: string; to: string; stepMs: number; retentionDays?: number }

function queryOf(path: string, view: UsageGraphView | undefined, zoom: Stretch | null): string {
  const q = new URLSearchParams({ tz: String(tz()) });
  if (zoom) { q.set('from', new Date(zoom.from).toISOString()); q.set('to', new Date(zoom.to).toISOString()); }
  else if (view) {
    if ('preset' in view.range) q.set('range', view.range.preset);
    else { q.set('from', view.range.from); q.set('to', view.range.to); }
  }
  return `${path}?${q}`;
}

/** The graph step as people read it: `per 15 minutes`, `per hour`, `per 6 hours`, `per day`, `per week`. */
function stepText(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `per ${Math.round(ms / 60_000)} minutes` : h === 1 ? 'per hour' : h < 24 ? `per ${h} hours` : h === 24 ? 'per day' : h === 168 ? 'per week' : `per ${h / 24} days`;
}

export function UsageGraphCard<T extends GraphData>({ path, seriesOf, linesOf, save, title, empty, what = 'usage history', recordedBy = 'usage', className }: {
  path: string; save?: (view: UsageGraphView) => void; title: string; empty: string;
  /** What it reads, as its loading and error lines name it. */
  what?: string;
  /** Which stream count reads it again: new usage samples, or new machine samples. */
  recordedBy?: 'usage' | 'machine';
  className?: string;
} & ({ seriesOf: (data: T) => UsageSeries[]; linesOf?: never } | { linesOf: (data: T) => GraphLine[]; seriesOf?: never })) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The saved view: undefined until the first read answers it.
  const [view, setView] = useState<UsageGraphView | undefined>(undefined);
  // The stretch zoomed to; null: the view's range.
  const [zoom, setZoom] = useState<Stretch | null>(null);
  // Lines the legend toggled: hidden (true) or shown (false); the rest as by default (informational ones hidden).
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const recorded = useHopper((s) => s.recorded[recordedBy]);

  const load = useCallback(async () => {
    try {
      const h = await get<T>(queryOf(path, view, zoom));
      setData(h);
      setError(null);
      if (!view) setView(h.view);
    } catch (e) { setError((e as Error).message); }
    // A new sample told by the stream (`recorded`) reads again, as a new view does.
  }, [path, view, zoom, recorded]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoll(load, 60_000);

  const lines = useMemo(() => (!data ? [] : linesOf ? linesOf(data) : graphLines(seriesOf!(data))), [data, seriesOf, linesOf]);
  const hidden = useMemo(() => hiddenLines(lines, toggled), [lines, toggled]);
  const toggle = (key: string) => setToggled((t) => new Map(t).set(key, !hidden.has(key)));

  const current = view ?? data?.view;
  // The zoomed stretch at once, before its read answers; else the stretch the last read covered.
  const shown = zoom ?? (data ? { from: Date.parse(data.from), to: Date.parse(data.to) } : null);
  const maxMs = (data?.retentionDays ?? DEFAULT_KEPT_DAYS) * DAY;
  const zoomBy = (factor: number) => { if (shown) setZoom(zoomed(shown, factor, (shown.from + shown.to) / 2, { now: Date.now(), maxMs })); };
  const choose = (next: UsageGraphView) => { setZoom(null); setView(next); save?.(next); };
  const rangeTab = zoom ? '' : current && 'preset' in current.range ? current.range.preset : '';

  return (
    <Panel title={title} icon={LineChart} {...(className ? { className } : {})} count={lines.length ? `${lines.length - hidden.size} of ${lines.length}` : ''}>
      {current && (
        <div data-slot="usage-graph-controls" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Tabs value={rangeTab} onValueChange={(v) => choose({ range: { preset: v as typeof GRAPH_PRESETS[number] } })}>
            <TabsList className="h-7">
              {GRAPH_PRESETS.map((p) => <TabsTrigger key={p} value={p} className="px-2 text-xs">{p}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-1">
            <Button type="button" size="icon" variant="outline" className="size-7" aria-label="Zoom in" title="Zoom in" disabled={!shown} onClick={() => zoomBy(0.5)}><ZoomIn /></Button>
            <Button type="button" size="icon" variant="outline" className="size-7" aria-label="Zoom out" title="Zoom out" disabled={!shown} onClick={() => zoomBy(2)}><ZoomOut /></Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!zoom} onClick={() => setZoom(null)}><RotateCcw /> Reset</Button>
          </div>
          {data && <span data-slot="usage-graph-step" className="text-muted-foreground">{stepText(data.stepMs)}</span>}
        </div>
      )}
      {error && !data ? <Empty>{what} unavailable: {error}</Empty>
        : !data || !shown ? <Empty>reading the {what}…</Empty>
          : !lines.length ? <Empty>{empty}</Empty>
            : <>
              <UsageGraph lines={lines} hidden={hidden} from={shown.from} to={shown.to} stepMs={data.stepMs} maxMs={maxMs} onZoom={setZoom} />
              <div data-slot="usage-graph-legend" className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {lines.map((l) => (
                  <button key={l.key} type="button" aria-pressed={!hidden.has(l.key)} onClick={() => toggle(l.key)}
                    className={cn('flex min-w-0 items-center gap-1.5 rounded px-1 text-left text-[11px] break-all text-muted-foreground hover:text-foreground', hidden.has(l.key) && 'opacity-40 line-through')}>
                    <LineSwatch line={l} />{l.label}
                  </button>
                ))}
              </div>
            </>}
    </Panel>
  );
}
