// Overview: numbers, charts, the board, live activity — everything at a glance.
import { AttentionPanel, LivePanel } from './activity';
import { ThroughputPanel, TimelinePanel, UsagePanel } from './charts';
import { KpiRow } from './kpis';
import { LanesPanel } from './lanes';
import { EndedPanel, WaitingPanel } from './queue';

export function Overview() {
  return (
    <div className="space-y-3">
      <KpiRow />
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2"><TimelinePanel /></div>
        <AttentionPanel />
      </div>
      <div className="grid gap-3 xl:grid-cols-3">
        <LanesPanel />
        <WaitingPanel />
        <EndedPanel />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2"><ThroughputPanel /></div>
        <UsagePanel />
      </div>
      <LivePanel />
    </div>
  );
}
