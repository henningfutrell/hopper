// The overview's charts: throughput, lane timeline, usage.
import { BarChart3, Gauge as GaugeIcon, GanttChart } from 'lucide-react';
import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Empty, Panel } from '@/components/panel';
import { Gauge } from '@/charts/gauge';
import { LaneTimeline, OUTCOME_TONE } from '@/charts/lane-timeline';
import { THROUGHPUT_LEGEND, ThroughputChart } from '@/charts/throughput';
import { COLOR } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';

const Legend = ({ items }: { items: readonly { key: string; color: string }[] }) => (
  <div className="hidden items-center gap-3 sm:flex">
    {items.map(({ key, color }) => (
      <span key={key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-2 rounded-sm" style={{ background: color }} />{key}</span>
    ))}
  </div>
);

export function ThroughputPanel() {
  const history = useHopper((s) => s.history);
  const now = useNow();
  return (
    <Panel title="Ended per hour" icon={BarChart3} count="24 h" action={<Legend items={THROUGHPUT_LEGEND} />}>
      <ThroughputChart history={history} now={now} />
    </Panel>
  );
}

const WINDOWS = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000 } as const;
type Win = keyof typeof WINDOWS;
const OUTCOMES = Object.entries(OUTCOME_TONE).map(([key, tone]) => ({ key, color: COLOR[tone] }));

export function TimelinePanel() {
  const history = useHopper((s) => s.history);
  const machines = useHopper((s) => s.machines);
  const nameOf = useJobName();
  const now = useNow();
  const [win, setWin] = useState<Win>('1h');
  const lanes = machines.flatMap((m) => m.lanes.map((l) => l.id));
  return (
    <Panel title="Lane timeline" icon={GanttChart} action={<>
      <Legend items={OUTCOMES} />
      <Tabs value={win} onValueChange={(v) => setWin(v as Win)}>
        <TabsList className="h-7">{Object.keys(WINDOWS).map((w) => <TabsTrigger key={w} value={w} className="px-2 text-xs">{w}</TabsTrigger>)}</TabsList>
      </Tabs>
    </>}>
      <LaneTimeline history={history} now={now} windowMs={WINDOWS[win]} lanes={lanes} nameOf={nameOf} />
    </Panel>
  );
}

export function UsagePanel() {
  const machines = useHopper((s) => s.machines);
  const readings = machines.flatMap((m) => m.usage);
  return (
    <Panel title="Usage" icon={GaugeIcon} count={readings.length || ''} bodyClassName="flex flex-wrap justify-around gap-4">
      {readings.length ? readings.map((r) => (
        <div key={`${r.source}-${r.machineId ?? ''}`} className="flex flex-col items-center">
          <Gauge fraction={r.limit > 0 ? r.used / r.limit : 0} label={r.source} sub={`${r.used}/${r.limit} ${r.unit}`} />
          <div className="font-mono text-xs text-muted-foreground">{r.source}{r.machineId && ` @${r.machineId}`}</div>
        </div>
      )) : <Empty>no usage sources: lanes are capped by machines only</Empty>}
    </Panel>
  );
}
