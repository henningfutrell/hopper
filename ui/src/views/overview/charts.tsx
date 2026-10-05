// The overview's charts: throughput, lane timeline, usage. Their settings come from the overview layout.
import { BarChart3, Gauge as GaugeIcon, GanttChart } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Empty, Panel } from '@/components/panel';
import { LaneTimeline, OUTCOME_TONE } from '@/charts/lane-timeline';
import { THROUGHPUT_LEGEND, ThroughputChart } from '@/charts/throughput';
import { COLOR } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { usePoll } from '@/hooks/use-poll';
import { ReadingGauge } from '@/components/reading';
import { orderReadings, readingKey } from '@/model/usage';
import { TIMELINE_WINDOWS, type TimelineWindow } from '@/model/overview-layout';
import { refreshUsage, useHopper } from '@/store';
import { useJobBoard, useJobName, useLaneSpans } from '@/store/selectors';
import { cn } from '@/lib/utils';

// `show` is the breakpoint from which the legend fits beside the panel's other actions.
const Legend = ({ items, show = 'sm:flex' }: { items: readonly { key: string; color: string }[]; show?: string }) => (
  <div className={cn('hidden items-center gap-3', show)}>
    {items.map(({ key, color }) => (
      <span key={key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className="size-2 rounded-sm" style={{ background: color }} />{key}</span>
    ))}
  </div>
);

export function ThroughputPanel({ hours }: { hours: number }) {
  const { ended } = useJobBoard();
  const now = useNow();
  return (
    <Panel title="Ended per hour" icon={BarChart3} count={`${hours} h`} action={<Legend items={THROUGHPUT_LEGEND} />}>
      <ThroughputChart ended={ended} now={now} hours={hours} />
    </Panel>
  );
}

const WINDOWS: Record<TimelineWindow, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000 };
const OUTCOMES = Object.entries(OUTCOME_TONE).map(([key, tone]) => ({ key, color: COLOR[tone] }));

/** `window` is the overview layout's; choosing another on the panel sets it there. */
export function TimelinePanel({ window: win, onWindow }: { window: TimelineWindow; onWindow: (w: TimelineWindow) => void }) {
  const machines = useHopper((s) => s.machines);
  const nameOf = useJobName();
  const now = useNow();
  const spans = useLaneSpans(now - WINDOWS[win]);
  const lanes = machines.flatMap((m) => m.lanes.map((l) => l.id));
  return (
    <Panel title="Lane timeline" icon={GanttChart} action={<>
      <Legend items={OUTCOMES} show="xl:flex" />
      <Tabs value={win} onValueChange={(v) => onWindow(v as TimelineWindow)}>
        <TabsList className="h-7">{TIMELINE_WINDOWS.map((w) => <TabsTrigger key={w} value={w} className="px-2 text-xs">{w}</TabsTrigger>)}</TabsList>
      </Tabs>
    </>}>
      <LaneTimeline spans={spans} now={now} windowMs={WINDOWS[win]} lanes={lanes} nameOf={nameOf} />
    </Panel>
  );
}

export function UsagePanel() {
  const usage = useHopper((s) => s.usage);
  const now = useNow();
  usePoll(refreshUsage, 60_000);
  const readings = orderReadings(usage?.readings ?? []);
  return (
    <Panel title="Usage" icon={GaugeIcon} count={readings.length || ''} action={<a href="#usage" className="text-xs text-muted-foreground hover:text-foreground">details</a>}
      bodyClassName="flex flex-wrap justify-around gap-x-2 gap-y-4">
      {readings.length ? readings.map((r) => <ReadingGauge key={readingKey(r)} r={r} now={now} showSource />)
        : <Empty>{usage?.sources.some((s) => s.problem) ? `no readings: ${usage.sources.find((s) => s.problem)!.problem}` : 'no usage sources: lanes are capped by machines only'}</Empty>}
    </Panel>
  );
}
