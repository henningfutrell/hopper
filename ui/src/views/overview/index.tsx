// Overview: numbers, charts, the board, live activity — everything at a glance, laid out as the
// viewer's overview layout says (model/overview-layout.ts, issue #73). Arrange (issue #86) lets the
// viewer drag panels where they see fit, or step them with Move earlier / Move later.
import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, GripVertical, LayoutGrid, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDragToPlace } from '@/hooks/use-drag-to-place';
import { setOverviewLayout, useOverviewLayout } from '@/hooks/use-overview-layout';
import {
  PANEL_TITLES, placePanel, setSetting, type OverviewLayout, type PanelId, type PanelPlacement, type PanelWidth,
} from '@/model/overview-layout';
import { cn } from '@/lib/utils';
import { AttentionPanel, LivePanel } from './activity';
import { ThroughputPanel, TimelinePanel, UsagePanel } from './charts';
import { Customize } from './customize';
import { KpiRow } from './kpis';
import { LanesPanel } from './lanes';
import { EndedPanel, WaitingPanel } from './queue';

// Literal class names, so Tailwind finds them.
const SPAN: Record<PanelWidth, string> = { 1: 'lg:col-span-1', 2: 'lg:col-span-2', 3: 'lg:col-span-3' };

function OverviewPanel({ id, layout }: { id: PanelId; layout: OverviewLayout }) {
  const s = layout.settings;
  switch (id) {
    case 'kpis': return <KpiRow />;
    case 'timeline': return <TimelinePanel window={s.timelineWindow} onWindow={(w) => setOverviewLayout(setSetting(layout, 'timelineWindow', w))} />;
    case 'attention': return <AttentionPanel />;
    case 'lanes': return <LanesPanel />;
    case 'waiting': return <WaitingPanel />;
    case 'ended': return <EndedPanel />;
    case 'throughput': return <ThroughputPanel hours={s.throughputHours} />;
    case 'usage': return <UsagePanel source={s.usageSource} onSource={(n) => setOverviewLayout(setSetting(layout, 'usageSource', n))} />;
    case 'live': return <LivePanel count={s.liveEvents} />;
  }
}

/** Over a panel while arranging: it is dragged as a whole, or stepped past its shown neighbours. */
function ArrangeCover({ id, before, after, layout }: { id: PanelId; before?: PanelPlacement; after?: PanelPlacement; layout: OverviewLayout }) {
  const to = (at?: PanelPlacement) => at && setOverviewLayout(placePanel(layout, id, at.id));
  return (
    <div className="absolute inset-0 z-10 flex cursor-grab items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary/50 bg-background/70 backdrop-blur-[2px] active:cursor-grabbing">
      <Button size="icon-xs" variant="ghost" aria-label="Move earlier" disabled={!before} onClick={() => to(before)}><ChevronLeft /></Button>
      <span className="flex items-center gap-1 text-sm font-medium"><GripVertical className="size-4 text-muted-foreground" />{PANEL_TITLES[id]}</span>
      <Button size="icon-xs" variant="ghost" aria-label="Move later" disabled={!after} onClick={() => to(after)}><ChevronRight /></Button>
    </div>
  );
}

export function Overview() {
  const layout = useOverviewLayout();
  const [arranging, setArranging] = useState(false);
  const { props: drag } = useDragToPlace<PanelId>((id, at) => setOverviewLayout(placePanel(layout, id, at)), arranging);
  const shown = layout.panels.filter((p) => p.shown);
  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-1">
        {arranging
          ? <Button variant="secondary" size="xs" onClick={() => setArranging(false)}><Check />Done</Button>
          : <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setArranging(true)}><LayoutGrid />Arrange</Button>}
        <Customize layout={layout}>
          <Button variant="ghost" size="xs" className="text-muted-foreground"><Settings2 />Customize</Button>
        </Customize>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {shown.map((p, i) => (
          <div key={p.id} data-overview-panel={p.id} {...drag(p.id)}
            className={cn('relative min-w-0 rounded-xl', SPAN[p.width], 'data-[dragging]:opacity-40 data-[drop-target]:ring-2 data-[drop-target]:ring-primary')}>
            <OverviewPanel id={p.id} layout={layout} />
            {arranging && <ArrangeCover id={p.id} before={shown[i - 1]} after={shown[i + 1]} layout={layout} />}
          </div>
        ))}
      </div>
    </div>
  );
}
