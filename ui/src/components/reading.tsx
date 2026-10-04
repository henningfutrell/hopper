// One usage reading as a gauge: its window, used of limit, when it resets, and whether it throttles.
import { Gauge } from '@/charts/gauge';
import { readingLabel, resetsIn } from '@/model/usage';
import type { UsageReading } from '@/model/wire';

export function ReadingGauge({ r, now, size = 104, showSource }: { r: UsageReading; now: number; size?: number; showSource?: boolean }) {
  const label = readingLabel(r);
  const reset = r.resetsAt ? resetsIn(r.resetsAt, now) : '';
  return (
    <div className="flex w-[7.5rem] flex-col items-center gap-0.5 text-center">
      <Gauge fraction={r.limit > 0 ? r.used / r.limit : 0} label={label} sub={`${r.used}/${r.limit} ${r.unit}`} size={size} />
      <div className="max-w-full truncate font-mono text-xs" title={label}>{label}</div>
      {showSource && r.window && <div className="max-w-full truncate text-[11px] text-muted-foreground">{r.source}{r.machineId && ` @${r.machineId}`}</div>}
      {reset && <div className="num text-[11px] text-muted-foreground">{reset}</div>}
      {r.informational && <div className="rounded border px-1.5 text-[10px] text-muted-foreground" title="This budget limits one model only, not every job: shown, never throttling">does not throttle</div>}
    </div>
  );
}
