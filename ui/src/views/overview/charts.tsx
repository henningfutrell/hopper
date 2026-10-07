// The overview's charts: throughput, lane timeline, usage. Their settings come from the overview layout.
import { BarChart3, Gauge as GaugeIcon, GanttChart } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Empty, Panel } from '@/components/panel';
import { LaneTimeline, OUTCOME_TONE, WAIT_SWATCH } from '@/charts/lane-timeline';
import { THROUGHPUT_LEGEND, ThroughputChart } from '@/charts/throughput';
import { COLOR } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { usePoll } from '@/hooks/use-poll';
import { ReadingGauge } from '@/components/reading';
import { laneName } from '@/model/board';
import { OPERATOR_LED_ROW } from '@/model/history';
import { orderReadings, readingKey, shownSource } from '@/model/usage';
import type { UsageSourceReport } from '@/model/wire';
import { TIMELINE_WINDOWS, type TimelineWindow } from '@/model/overview-layout';
import { refreshUsage, useHopper } from '@/store';
import { useJobBoard, useJobName, useLaneSpans, useQuestionWaits } from '@/store/selectors';
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
const OUTCOMES = [...Object.entries(OUTCOME_TONE).map(([key, tone]) => ({ key, color: COLOR[tone] })), { key: 'waiting answer', color: WAIT_SWATCH }];

/** `window` is the overview layout's; choosing another on the panel sets it there. */
export function TimelinePanel({ window: win, onWindow }: { window: TimelineWindow; onWindow: (w: TimelineWindow) => void }) {
  const machines = useHopper((s) => s.machines);
  const nameOf = useJobName();
  const now = useNow();
  const spans = useLaneSpans(now - WINDOWS[win]);
  const waits = useQuestionWaits(now - WINDOWS[win]);
  const lanes = machines.flatMap((m) => m.lanes.map((l) => l.id));
  return (
    <Panel title="Lane timeline" icon={GanttChart} action={<>
      <Legend items={OUTCOMES} show="xl:flex" />
      <Tabs value={win} onValueChange={(v) => onWindow(v as TimelineWindow)}>
        <TabsList className="h-7">{TIMELINE_WINDOWS.map((w) => <TabsTrigger key={w} value={w} className="px-2 text-xs">{w}</TabsTrigger>)}</TabsList>
      </Tabs>
    </>}>
      <LaneTimeline spans={spans} waits={waits} now={now} windowMs={WINDOWS[win]} lanes={lanes} nameOf={nameOf} laneNameOf={(id) => (id === OPERATOR_LED_ROW ? 'operator-led' : laneName(id, machines))} />
    </Panel>
  );
}

/** One usage source's readings (issue #85): with several, a tab per source picks it; `source` is the overview layout's. */
export function UsagePanel({ source, onSource }: { source: string | undefined; onSource: (name: string) => void }) {
  const usage = useHopper((s) => s.usage);
  const now = useNow();
  usePoll(refreshUsage, 60_000);
  const sources = usage?.sources ?? [];
  const shown = shownSource(sources, source);
  const several = sources.length > 1;
  const readings = orderReadings((usage?.readings ?? []).filter((r) => !several || r.source === shown));
  const identity = several ? sources.find((s) => s.name === shown)?.account?.identity : undefined;
  return (
    <Panel title="Usage" icon={GaugeIcon} count={readings.length || ''} action={<>
      {several && (
        <Tabs value={shown} onValueChange={onSource}>
          <TabsList className="h-7">{sources.map((s) => <TabsTrigger key={s.name} value={s.name} className="px-2 text-xs" title={s.account?.identity}>{s.name}</TabsTrigger>)}</TabsList>
        </Tabs>
      )}
      <a href="#usage" className="text-xs text-muted-foreground hover:text-foreground">details</a>
    </>} bodyClassName="flex flex-wrap justify-around gap-x-2 gap-y-4">
      {identity && <div className="w-full truncate text-center font-mono text-xs text-muted-foreground">{identity}</div>}
      {readings.length ? readings.map((r) => <ReadingGauge key={readingKey(r)} r={r} now={now} showSource={!several} />)
        : <Empty>{usageEmpty(sources, shown, several)}</Empty>}
    </Panel>
  );
}

/** Why the panel has no gauges: the shown source's problem, else any source's, else that there is none. */
function usageEmpty(sources: UsageSourceReport[], shown: string | undefined, several: boolean): string {
  const problem = several ? sources.find((s) => s.name === shown)?.problem : sources.find((s) => s.problem)?.problem;
  if (problem) return `no readings: ${problem}`;
  return sources.length ? 'no readings now' : 'no usage sources: lanes are capped by machines only';
}
