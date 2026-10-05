// Customize (issue #73): the viewer's overview layout — each overview panel shown or hidden, moved,
// sized in thirds of the row — and each panel's settings. Every change applies at once and is kept
// by this browser; Reset forgets it.
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { resetOverviewLayout, setOverviewLayout } from '@/hooks/use-overview-layout';
import {
  LIVE_EVENTS, PANEL_TITLES, PANEL_WIDTHS, THROUGHPUT_HOURS, TIMELINE_WINDOWS, WIDTH_NAMES,
  movePanel, setPanel, setSetting, type OverviewLayout, type OverviewSettings, type PanelPlacement,
} from '@/model/overview-layout';
import { cn } from '@/lib/utils';

const WIDTH_MARK = { 1: '⅓', 2: '⅔', 3: 'full' } as const;

/** A row of buttons, the chosen one pressed; a setting's group carries its caption. */
function Choice<T extends string | number>({ label, options, value, onChoose, name = String, title, caption }: {
  label: string; options: readonly T[]; value: T; onChoose: (v: T) => void; name?: (v: T) => string; title?: (v: T) => string; caption?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5 rounded-md border p-0.5">
      {caption && <span className="px-1.5 text-[11px] text-muted-foreground">{label}</span>}
      {options.map((o) => (
        <Button key={o} size="xs" variant="ghost" aria-pressed={o === value} {...(title ? { 'aria-label': title(o), title: title(o) } : {})}
          className={cn('h-6 px-2 text-xs', o === value ? 'bg-muted text-foreground' : 'text-muted-foreground')} onClick={() => onChoose(o)}>
          {name(o)}
        </Button>
      ))}
    </div>
  );
}

/** The settings a panel has, if any. */
function PanelSettings({ p, layout }: { p: PanelPlacement; layout: OverviewLayout }) {
  const set = <K extends keyof OverviewSettings>(k: K) => (v: OverviewSettings[K]) => setOverviewLayout(setSetting(layout, k, v));
  const s = layout.settings;
  switch (p.id) {
    case 'timeline': return <Choice label="window" caption options={TIMELINE_WINDOWS} value={s.timelineWindow} onChoose={set('timelineWindow')} />;
    case 'throughput': return <Choice label="last" caption options={THROUGHPUT_HOURS} value={s.throughputHours} onChoose={set('throughputHours')} name={(h) => `${h} h`} />;
    case 'live': return <Choice label="events" caption options={LIVE_EVENTS} value={s.liveEvents} onChoose={set('liveEvents')} />;
    default: return null;
  }
}

function PanelRow({ p, i, layout }: { p: PanelPlacement; i: number; layout: OverviewLayout }) {
  const title = PANEL_TITLES[p.id];
  const last = layout.panels.length - 1;
  return (
    <li data-customize-panel={p.id} className={cn('space-y-2 px-4 py-3', !p.shown && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <Switch checked={p.shown} aria-label={`Show ${title}`} onCheckedChange={(shown) => setOverviewLayout(setPanel(layout, p.id, { shown }))} />
        <span className="flex-1 text-sm font-medium">{title}</span>
        <Button size="icon-xs" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => setOverviewLayout(movePanel(layout, p.id, -1))}><ArrowUp /></Button>
        <Button size="icon-xs" variant="ghost" aria-label="Move down" disabled={i === last} onClick={() => setOverviewLayout(movePanel(layout, p.id, 1))}><ArrowDown /></Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-10">
        <Choice label="Width" options={PANEL_WIDTHS} value={p.width} onChoose={(width) => setOverviewLayout(setPanel(layout, p.id, { width }))}
          name={(w) => WIDTH_MARK[w]} title={(w) => WIDTH_NAMES[w]} />
        <PanelSettings p={p} layout={layout} />
      </div>
    </li>
  );
}

export function Customize({ layout, children }: { layout: OverviewLayout; children: React.ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent className="gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Customize the overview</SheetTitle>
          <SheetDescription>Which panels show, in what order and how wide. Kept by this browser only.</SheetDescription>
        </SheetHeader>
        <ol className="min-w-0 flex-1 divide-y overflow-x-hidden overflow-y-auto">
          {layout.panels.map((p, i) => <PanelRow key={p.id} p={p} i={i} layout={layout} />)}
        </ol>
        <SheetFooter className="border-t">
          <Button variant="outline" size="sm" onClick={resetOverviewLayout}><RotateCcw />Reset</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
