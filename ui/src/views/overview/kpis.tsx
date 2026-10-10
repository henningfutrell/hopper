// The KPI row: what is happening right now, each number with the shape of its last hours.
import { Activity, CircleCheck, CircleX, Layers, MessageCircleQuestion, Timer } from 'lucide-react';
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { COLOR, TEXT, type Tone } from '@/components/status';
import { Sparkline } from '@/charts/sparkline';
import { useNow } from '@/hooks/use-now';
import { kpis } from '@/model/board';
import { concurrency, throughput } from '@/model/history';
import { useHopper } from '@/store';
import { useJobBoard, useLaneSpans } from '@/store/selectors';
import { cn } from '@/lib/utils';

const QUARTER = 15 * 60_000;
const HOUR = 4 * QUARTER;

function Kpi({ kpi, label, icon: Icon, value, sub, tone, spark, alert }: {
  kpi: string; label: string; icon: typeof Activity; value: React.ReactNode; sub?: React.ReactNode; tone: Tone; spark?: number[]; alert?: boolean;
}) {
  return (
    <Card data-kpi={kpi} className={cn('relative gap-2 overflow-hidden px-4 py-3.5', alert && 'border-question/40 ring-1 ring-question/20')}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className={cn('size-3.5', TEXT[tone])} />{label}
      </div>
      <div data-slot="kpi-value" className="num text-2xl leading-none font-semibold tracking-tight sm:text-3xl">{value}</div>
      <div className="num min-h-4 text-xs text-muted-foreground">{sub}</div>
      {spark && <div className="-mx-4 -mb-3.5"><Sparkline values={spark} color={COLOR[tone]} height={28} /></div>}
    </Card>
  );
}

export function KpiRow() {
  const board = useJobBoard();
  const machines = useHopper((s) => s.machines);
  const now = useNow();
  const k = kpis(board, machines);
  const quarter = Math.floor(now / QUARTER);
  // Per quarter hour, not per tick: spans and buckets only move that often.
  const since = (quarter - 24) * QUARTER;
  const spans = useLaneSpans(since);
  const series = useMemo(() => {
    const ended = throughput(board.ended, now, HOUR, 24);
    return { running: concurrency(spans, now, QUARTER, 24), finished: ended.map((b) => b.finished), failed: ended.map((b) => b.failed) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute per quarter hour or new data
  }, [board.ended, spans, quarter]);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Kpi kpi="running" label="Running" icon={Activity} tone="busy" value={k.running} sub="lanes in use · 6 h" spark={series.running} />
      <Kpi kpi="lanes" label="Lanes" icon={Layers} tone="busy" value={<>{k.lanesBusy}<span className="text-muted-foreground">/{k.lanesMax}</span></>}
        sub={`${k.lanesOpen} open · ${Math.max(0, k.lanesMax - k.lanesOpen)} unopened`} />
      <Kpi kpi="waiting" label="Waiting" icon={Timer} tone={k.held ? 'warn' : 'muted'} value={k.waiting}
        sub={[k.held ? `${k.held} held` : 'none held', ...(k.parked ? [`${k.parked} parked`] : []), ...(k.waitingOn ? [`${k.waitingOn} on their own wait`] : [])].join(' · ')} />
      <Kpi kpi="waitingAnswer" label="On a question" icon={MessageCircleQuestion} tone="question" value={k.waitingAnswer} sub={k.waitingAnswer ? 'needs an answer' : 'nothing asked'} alert={k.waitingAnswer > 0} />
      <Kpi kpi="finished" label="Finished" icon={CircleCheck} tone="ok" value={k.finished} sub="in 24 h" spark={series.finished} />
      <Kpi kpi="failed" label="Failed" icon={CircleX} tone={k.failed ? 'bad' : 'muted'} value={k.failed} sub={k.cancelled ? `in 24 h · ${k.cancelled} cancelled` : 'in 24 h'} spark={series.failed} />
    </div>
  );
}
