// Overview: numbers, charts, the board, live activity — everything at a glance, laid out as the
// viewer's overview layout says (model/overview-layout.ts, issue #73).
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setOverviewLayout, useOverviewLayout } from '@/hooks/use-overview-layout';
import { setSetting, type OverviewLayout, type PanelId, type PanelWidth } from '@/model/overview-layout';
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
    case 'usage': return <UsagePanel />;
    case 'live': return <LivePanel count={s.liveEvents} />;
  }
}

export function Overview() {
  const layout = useOverviewLayout();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Customize layout={layout}>
          <Button variant="ghost" size="xs" className="text-muted-foreground"><Settings2 />Customize</Button>
        </Customize>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {layout.panels.filter((p) => p.shown).map((p) => (
          <div key={p.id} data-overview-panel={p.id} className={`min-w-0 ${SPAN[p.width]}`}><OverviewPanel id={p.id} layout={layout} /></div>
        ))}
      </div>
    </div>
  );
}
