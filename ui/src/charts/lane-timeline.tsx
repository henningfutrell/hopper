// What each lane ran, over a time window ending now: one row per lane, one bar per job run,
// coloured by how the run ended. Running bars grow with the clock.
import { scaleBand, scaleTime, timeFormat } from 'd3';
import { useMemo, useState } from 'react';
import { COLOR, type Tone } from '@/components/status';
import { useSize } from '@/hooks/use-size';
import { duration } from '@/model/format';
import type { LaneSpan, SpanOutcome } from '@/model/history';
import { TimeAxis } from './axis';

export const OUTCOME_TONE: Record<SpanOutcome, Tone> = {
  running: 'busy', finished: 'ok', failed: 'bad', cancelled: 'muted', requeued: 'warn', question: 'question',
};
const ROW = 26;
const M = { top: 4, right: 16, bottom: 22, left: 64 };
const hm = timeFormat('%H:%M');

export function LaneTimeline({ spans, now, windowMs, lanes, nameOf }: {
  /** From `useLaneSpans`: the event log reconciled with the job store. */
  spans: LaneSpan[]; now: number; windowMs: number; lanes: string[]; nameOf: (jobId: string) => string;
}) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<LaneSpan | null>(null);
  const since = now - windowMs;
  const rows = useMemo(() => [...new Set([...lanes, ...spans.map((s) => s.laneId)])].sort(), [lanes, spans]);
  const height = M.top + M.bottom + Math.max(1, rows.length) * ROW;
  const iw = Math.max(0, width - M.left - M.right);
  const x = scaleTime().domain([since, now]).range([0, iw]);
  const y = scaleBand<string>().domain(rows).range([0, rows.length * ROW]).paddingInner(0.3).paddingOuter(0.15);
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Lane activity timeline">
          <g transform={`translate(${M.left},${M.top})`}>
            {rows.map((laneId) => (
              <g key={laneId}>
                <rect x={0} y={y(laneId)} width={iw} height={y.bandwidth()} rx={3} className="fill-muted/40" />
                <text x={-8} y={(y(laneId) ?? 0) + y.bandwidth() / 2} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
                  {laneId.split('/').pop()}
                </text>
              </g>
            ))}
            {spans.map((s) => {
              const x0 = x(Math.max(s.start, since));
              const x1 = x(s.end ?? now);
              return (
                <rect key={`${s.jobId}-${s.start}`} x={x0} y={y(s.laneId)} width={Math.max(2, x1 - x0)} height={y.bandwidth()} rx={3}
                  fill={COLOR[OUTCOME_TONE[s.outcome]]} opacity={hover && hover !== s ? 0.4 : s.outcome === 'running' ? 0.95 : 0.75}
                  className={s.outcome === 'running' ? 'animate-pulse' : undefined}
                  onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(null)} />
              );
            })}
            <line x1={iw} x2={iw} y1={0} y2={rows.length * ROW} stroke="var(--busy)" strokeOpacity={0.6} strokeDasharray="2 2" />
            <TimeAxis scale={x} y={rows.length * ROW} ticks={width < 500 ? 3 : 6} format={hm} />
          </g>
        </svg>
      )}
      {!rows.length && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground/70">no lane activity in this window</div>}
      {hover && (
        <div className="pointer-events-none absolute top-0 right-0 max-w-72 rounded-md border bg-popover/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur">
          <div className="truncate font-medium">{nameOf(hover.jobId)}</div>
          <div className="num text-muted-foreground">
            {hover.laneId} · {hm(new Date(hover.start))}–{hover.end ? hm(new Date(hover.end)) : 'now'} · {duration(((hover.end ?? now) - hover.start) / 1000)} · {hover.outcome}
          </div>
        </div>
      )}
    </div>
  );
}
