// A usage graph in a panel (issue #385): the lines over the graph range, the range (a preset or a custom
// stretch) and the graph step to choose — a change redraws at once — and a legend that names each line and
// toggles it. The Overview's shows the user's own lines and saves the choice for them; Settings → Users
// shows the instance admin the lines summed over every user.
import { useCallback, useMemo, useState } from 'react';
import { LineChart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { LineSwatch, UsageGraph } from '@/charts/usage-history';
import { usePoll } from '@/hooks/use-poll';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { fromLocalInput, GRAPH_PRESETS, GRAPH_STEPS, graphLines, hiddenLines, toLocalInput } from '@/model/usage-history';
import type { UsageGraphView, UsageSeries } from '@/model/wire';

const tz = () => -new Date().getTimezoneOffset();

/** What either usage graph read answers. */
export interface GraphData { view: UsageGraphView; from: string; to: string; stepMs: number }

function queryOf(path: string, view: UsageGraphView | undefined): string {
  const q = new URLSearchParams({ tz: String(tz()) });
  if (view) {
    if ('preset' in view.range) q.set('range', view.range.preset);
    else { q.set('from', view.range.from); q.set('to', view.range.to); }
    q.set('step', view.step);
  }
  return `${path}?${q}`;
}

export function UsageGraphCard<T extends GraphData>({ path, seriesOf, save, title, empty }: {
  path: string; seriesOf: (data: T) => UsageSeries[]; save?: (view: UsageGraphView) => void; title: string; empty: string;
}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The view on screen: undefined until the saved one is read.
  const [view, setView] = useState<UsageGraphView | undefined>(undefined);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  // Lines the legend toggled: hidden (true) or shown (false); the rest as by default (informational ones hidden).
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());

  const load = useCallback(async () => {
    try {
      const h = await get<T>(queryOf(path, view));
      setData(h);
      setError(null);
      if (!view) setView(h.view);
    } catch (e) { setError((e as Error).message); }
  }, [path, view]);
  usePoll(load, 60_000);

  const lines = useMemo(() => graphLines(data ? seriesOf(data) : []), [data, seriesOf]);
  const hidden = useMemo(() => hiddenLines(lines, toggled), [lines, toggled]);

  const choose = (next: UsageGraphView) => {
    setView(next);
    save?.(next);
  };
  const toggle = (key: string) => setToggled((t) => new Map(t).set(key, !hidden.has(key)));

  const current = view ?? data?.view;
  const rangeTab = current ? ('preset' in current.range ? current.range.preset : 'custom') : '7d';
  const applyCustom = () => {
    const from = custom && fromLocalInput(custom.from);
    const to = custom && fromLocalInput(custom.to);
    if (current && from && to && Date.parse(from) < Date.parse(to)) choose({ ...current, range: { from, to } });
  };

  return (
    <Panel title={title} icon={LineChart} count={lines.length ? `${lines.length - hidden.size} of ${lines.length}` : ''} action={current && <>
      <Tabs value={rangeTab} onValueChange={(v) => {
        if (v === 'custom') {
          const to = data?.to ?? new Date().toISOString();
          const from = data?.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
          setCustom({ from: toLocalInput(from), to: toLocalInput(to) });
        } else { setCustom(null); choose({ ...current, range: { preset: v as typeof GRAPH_PRESETS[number] } }); }
      }}>
        <TabsList className="h-7">
          {GRAPH_PRESETS.map((p) => <TabsTrigger key={p} value={p} className="px-2 text-xs">{p}</TabsTrigger>)}
          <TabsTrigger value="custom" className="px-2 text-xs">custom</TabsTrigger>
        </TabsList>
      </Tabs>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        per
        <select aria-label="Graph step" className={cn(FIELD, 'h-7 w-auto font-sans')} value={current.step}
          onChange={(e) => choose({ ...current, step: e.target.value as UsageGraphView['step'] })}>
          {GRAPH_STEPS.map((s) => <option key={s.step} value={s.step}>{s.label}</option>)}
        </select>
      </label>
    </>}>
      {custom && (
        <form className="mb-3 flex flex-wrap items-end gap-2 text-xs" onSubmit={(e) => { e.preventDefault(); applyCustom(); }}>
          <label className="grid gap-1">from<Input type="datetime-local" className="h-8 w-auto text-xs" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label className="grid gap-1">to<Input type="datetime-local" className="h-8 w-auto text-xs" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          <Button type="submit" size="sm" variant="secondary">Show</Button>
        </form>
      )}
      {error && !data ? <Empty>usage history unavailable: {error}</Empty>
        : !data ? <Empty>reading the usage history…</Empty>
          : !lines.length ? <Empty>{empty}</Empty>
            : <>
              <UsageGraph lines={lines} hidden={hidden} from={Date.parse(data.from)} to={Date.parse(data.to)} stepMs={data.stepMs} />
              <div data-slot="usage-graph-legend" className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {lines.map((l) => (
                  <button key={l.key} type="button" aria-pressed={!hidden.has(l.key)} onClick={() => toggle(l.key)}
                    className={cn('flex items-center gap-1.5 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground', hidden.has(l.key) && 'opacity-40 line-through')}>
                    <LineSwatch line={l} />{l.label}
                  </button>
                ))}
              </div>
            </>}
    </Panel>
  );
}
