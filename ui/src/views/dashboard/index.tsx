// Dashboard: numbers, charts, the board, live activity — everything at a glance, laid out as the
// viewer's dashboard layout says (model/dashboard-layout.ts, issue #73). Arrange (issue #86) lets the
// viewer drag panels where they see fit, or step them with Move earlier / Move later. While the hopper's GitHub app reaches no
// repository, Install the app on GitHub leads (issue #2759).
import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, GripVertical, LayoutGrid, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDragToPlace } from '@/hooks/use-drag-to-place';
import { setDashboardLayout, useDashboardLayout } from '@/hooks/use-dashboard-layout';
import {
  PANEL_TITLES, placePanel, setSetting, type DashboardLayout, type PanelId, type PanelPlacement, type PanelWidth,
} from '@/model/dashboard-layout';
import { cn } from '@/lib/utils';
import { AttentionPanel, LivePanel } from './activity';
import { ThroughputPanel, TimelinePanel, UsagePanel } from './charts';
import { Customize } from './customize';
import { KpiRow } from './kpis';
import { LanesPanel } from './lanes';
import { EndedPanel, WaitingPanel } from './queue';
import { TokenHistoryPanel } from './token-history';
import { UsageHistoryPanel } from './usage-history';
import { InstallAppNudge } from '../install-app';

// Literal class names, so Tailwind finds them.
const SPAN: Record<PanelWidth, string> = { 1: 'lg:col-span-1', 2: 'lg:col-span-2', 3: 'lg:col-span-3' };

function DashboardPanel({ id, layout }: { id: PanelId; layout: DashboardLayout }) {
  const s = layout.settings;
  switch (id) {
    case 'kpis': return <KpiRow />;
    case 'timeline': return <TimelinePanel window={s.timelineWindow} onWindow={(w) => setDashboardLayout(setSetting(layout, 'timelineWindow', w))} />;
    case 'attention': return <AttentionPanel />;
    case 'lanes': return <LanesPanel />;
    case 'waiting': return <WaitingPanel />;
    case 'ended': return <EndedPanel />;
    case 'throughput': return <ThroughputPanel hours={s.throughputHours} />;
    case 'usage': return <UsagePanel source={s.usageSource} onSource={(n) => setDashboardLayout(setSetting(layout, 'usageSource', n))} />;
    case 'usageHistory': return <UsageHistoryPanel />;
    case 'tokenHistory': return <TokenHistoryPanel split={s.tokenSplit} onSplit={(v) => setDashboardLayout(setSetting(layout, 'tokenSplit', v))} />;
    case 'live': return <LivePanel count={s.liveEvents} />;
  }
}

/** Over a panel while arranging: it is dragged as a whole, or stepped past its shown neighbours. */
function ArrangeCover({ id, before, after, layout }: { id: PanelId; before?: PanelPlacement; after?: PanelPlacement; layout: DashboardLayout }) {
  const to = (at?: PanelPlacement) => at && setDashboardLayout(placePanel(layout, id, at.id));
  return (
    <div className="absolute inset-0 z-10 flex cursor-grab items-center justify-center gap-1 rounded-xl border-2 border-dashed border-primary/50 bg-background/70 backdrop-blur-[2px] active:cursor-grabbing">
      <Button size="icon-xs" variant="ghost" aria-label="Move earlier" disabled={!before} onClick={() => to(before)}><ChevronLeft /></Button>
      <span className="flex items-center gap-1 text-sm font-medium"><GripVertical className="size-4 text-muted-foreground" />{PANEL_TITLES[id]}</span>
      <Button size="icon-xs" variant="ghost" aria-label="Move later" disabled={!after} onClick={() => to(after)}><ChevronRight /></Button>
    </div>
  );
}

export function Dashboard() {
  const layout = useDashboardLayout();
  const [arranging, setArranging] = useState(false);
  const { props: drag } = useDragToPlace<PanelId>((id, at) => setDashboardLayout(placePanel(layout, id, at)), arranging);
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
      <InstallAppNudge />
      <div className="grid gap-3 lg:grid-cols-3">
        {shown.map((p, i) => (
          <div key={p.id} data-dashboard-panel={p.id} {...drag(p.id)}
            className={cn('relative min-w-0 rounded-xl', SPAN[p.width], 'data-[dragging]:opacity-40 data-[drop-target]:ring-2 data-[drop-target]:ring-primary')}>
            <DashboardPanel id={p.id} layout={layout} />
            {arranging && <ArrangeCover id={p.id} before={shown[i - 1]} after={shown[i + 1]} layout={layout} />}
          </div>
        ))}
      </div>
    </div>
  );
}
