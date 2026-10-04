// Ended jobs per hour, stacked by outcome, for the last 24 h. Hover a bar for its counts.
import { max, scaleBand, scaleLinear, scaleTime, timeFormat } from 'd3';
import { useMemo, useState } from 'react';
import { COLOR } from '@/components/status';
import { useSize } from '@/hooks/use-size';
import { throughput, type Bucket } from '@/model/history';
import type { DomainEvent } from '@/model/wire';
import { GridY, TimeAxis } from './axis';

const HOUR = 3_600_000;
const KEYS = [
  { key: 'finished', color: COLOR.ok }, { key: 'failed', color: COLOR.bad }, { key: 'cancelled', color: COLOR.muted },
] as const;
const M = { top: 8, right: 16, bottom: 22, left: 26 };
const hour = timeFormat('%H:%M');

export function ThroughputChart({ history, now, height = 200 }: { history: DomainEvent[]; now: number; height?: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Bucket | null>(null);
  const hourNow = Math.floor(now / HOUR);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute per hour, not per tick
  const buckets = useMemo(() => throughput(history, now, HOUR, 24), [history, hourNow]);
  const iw = Math.max(0, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const x = scaleBand<number>().domain(buckets.map((b) => b.start)).range([0, iw]).paddingInner(0.28);
  const y = scaleLinear().domain([0, Math.max(4, max(buckets, (b) => b.finished + b.failed + b.cancelled) ?? 0)]).nice().range([ih, 0]);
  const first = buckets[0]?.start ?? now;
  const t = scaleTime().domain([first, first + 24 * HOUR]).range([0, iw]);
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Ended jobs per hour, last 24 hours">
          <g transform={`translate(${M.left},${M.top})`}>
            <GridY scale={y} x0={0} x1={iw} />
            {buckets.map((b) => {
              let base = 0;
              return (
                <g key={b.start} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)}>
                  <rect x={x(b.start)} y={0} width={x.bandwidth()} height={ih} fill="transparent" />
                  {KEYS.map(({ key, color }) => {
                    const v = b[key];
                    if (!v) return null;
                    const r = <rect key={key} x={x(b.start)} y={y(base + v)} width={x.bandwidth()} height={Math.max(1, y(base) - y(base + v))} rx={1.5} fill={color} opacity={hover && hover !== b ? 0.45 : 0.9} />;
                    base += v;
                    return r;
                  })}
                </g>
              );
            })}
            <TimeAxis scale={t} y={ih} ticks={width < 500 ? 4 : 8} format={hour} />
          </g>
        </svg>
      )}
      {hover && (
        <div className="pointer-events-none absolute top-1 right-1 rounded-md border bg-popover/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur">
          <div className="num mb-1 text-muted-foreground">{hour(new Date(hover.start))}–{hour(new Date(hover.start + HOUR))}</div>
          {KEYS.map(({ key, color }) => (
            <div key={key} className="flex items-center gap-2">
              <span className="size-2 rounded-sm" style={{ background: color }} /> {key} <span className="num ml-auto pl-3 font-medium">{hover[key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const THROUGHPUT_LEGEND = KEYS;
