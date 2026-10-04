// The KPI row: what is happening right now, each number with the shape of its last hours.
import { Activity, CircleCheck, CircleX, Layers, MessageCircleQuestion, Timer } from 'lucide-react';
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { COLOR, TEXT, type Tone } from '@/components/status';
import { Sparkline } from '@/charts/sparkline';
import { useNow } from '@/hooks/use-now';
import { kpis } from '@/model/board';
import { concurrency, laneSpans, throughput } from '@/model/history';
import { useHopper } from '@/store';
import { cn } from '@/lib/utils';

const QUARTER = 15 * 60_000;
const HOUR = 4 * QUARTER;

function Kpi({ label, icon: Icon, value, sub, tone, spark, alert }: {
  label: string; icon: typeof Activity; value: React.ReactNode; sub?: React.ReactNode; tone: Tone; spark?: number[]; alert?: boolean;
}) {
  return (
    <Card className={cn('relative gap-2 overflow-hidden px-4 py-3.5', alert && 'border-question/40 ring-1 ring-question/20')}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Icon className={cn('size-3.5', TEXT[tone])} />{label}
      </div>
      <div className="num text-2xl leading-none font-semibold tracking-tight sm:text-3xl">{value}</div>
      <div className="num min-h-4 text-xs text-muted-foreground">{sub}</div>
      {spark && <div className="-mx-4 -mb-3.5"><Sparkline values={spark} color={COLOR[tone]} height={28} /></div>}
    </Card>
  );
}

export function KpiRow() {
  const queue = useHopper((s) => s.queue);
  const machines = useHopper((s) => s.machines);
  const history = useHopper((s) => s.history);
  const now = useNow();
  const k = kpis(queue, machines);
  const quarter = Math.floor(now / QUARTER);
  const series = useMemo(() => {
    const spans = laneSpans(history, now - 6 * HOUR);
    const ended = throughput(history, now, HOUR, 24);
    return {
      running: concurrency(spans, now, QUARTER, 24),
      finished: ended.map((b) => b.finished),
      failed: ended.map((b) => b.failed),
      finished24: ended.reduce((s, b) => s + b.finished, 0),
      failed24: ended.reduce((s, b) => s + b.failed, 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute per quarter hour or new history
  }, [history, quarter]);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Kpi label="Running" icon={Activity} tone="busy" value={k.running} sub="lanes in use · 6 h" spark={series.running} />
      <Kpi label="Lanes" icon={Layers} tone="busy" value={<>{k.lanesBusy}<span className="text-muted-foreground">/{k.lanesMax}</span></>}
        sub={`${k.lanesOpen} open · ${Math.max(0, k.lanesMax - k.lanesOpen)} unopened`} />
      <Kpi label="Waiting" icon={Timer} tone={k.held ? 'warn' : 'muted'} value={k.waiting} sub={k.held ? `${k.held} held` : 'none held'} />
      <Kpi label="On a question" icon={MessageCircleQuestion} tone="question" value={k.onQuestion} sub={k.onQuestion ? 'needs an answer' : 'nothing asked'} alert={k.onQuestion > 0} />
      <Kpi label="Finished" icon={CircleCheck} tone="ok" value={k.finished} sub={`${series.finished24} in 24 h`} spark={series.finished} />
      <Kpi label="Failed" icon={CircleX} tone={k.failed ? 'bad' : 'muted'} value={k.failed} sub={`${series.failed24} in 24 h`} spark={series.failed} />
    </div>
  );
}
