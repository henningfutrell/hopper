// Tokens per day, stacked by repository or account (issue #2302). Hover a day for its stacks, tokens and estimated cost.
import { scaleBand, scaleLinear, scaleUtc, utcFormat } from 'd3';
import { useState } from 'react';
import { useSize } from '@/hooks/use-size';
import { tokenCount, type TokenDay, type TokenStack } from '@/model/token-ledger';
import { TimeAxis } from './axis';

const M = { top: 8, right: 16, bottom: 22, left: 40 };
const DAY = 86_400_000;
// A ledger day is a UTC day.
const date = utcFormat('%b %d');
const TICK = 'fill-muted-foreground text-[10px] num';
const at = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

export function TokenDaysChart({ days, stacks, height = 200 }: { days: TokenDay[]; stacks: TokenStack[]; height?: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<TokenDay | null>(null);
  const iw = Math.max(0, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const x = scaleBand<string>().domain(days.map((d) => d.day)).range([0, iw]).paddingInner(0.28);
  const y = scaleLinear().domain([0, Math.max(1000, ...days.map((d) => d.tokens))]).nice().range([ih, 0]);
  const first = days[0] ? at(days[0].day) : 0;
  const t = scaleUtc().domain([first, first + days.length * DAY]).range([0, iw]);
  const color = new Map(stacks.map((s) => [s.key, s.color]));
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Tokens per day, last ${days.length} days`}>
          <g transform={`translate(${M.left},${M.top})`}>
            {y.ticks(4).map((v) => (
              <g key={v}>
                <line x1={0} x2={iw} y1={y(v)} y2={y(v)} className="stroke-border" strokeDasharray={v === 0 ? undefined : '2 3'} />
                <text x={-6} y={y(v)} dy="0.32em" textAnchor="end" className={TICK}>{tokenCount(v)}</text>
              </g>
            ))}
            {days.map((d) => {
              let base = 0;
              return (
                <g key={d.day} data-token-day={d.day} onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}>
                  <rect x={x(d.day)} y={0} width={x.bandwidth()} height={ih} fill="transparent" />
                  {d.parts.map((p) => {
                    const r = <rect key={p.key} x={x(d.day)} y={y(base + p.tokens)} width={x.bandwidth()} height={Math.max(1, y(base) - y(base + p.tokens))} rx={1.5} fill={color.get(p.key)} opacity={hover && hover !== d ? 0.45 : 0.9} />;
                    base += p.tokens;
                    return r;
                  })}
                </g>
              );
            })}
            <TimeAxis scale={t} y={ih} ticks={width < 500 ? 3 : 6} format={date} />
          </g>
        </svg>
      )}
      {hover && (
        <div className="pointer-events-none absolute top-1 right-1 rounded-md border bg-popover/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur">
          <div className="num mb-1 text-muted-foreground">{date(new Date(at(hover.day)))} · {tokenCount(hover.tokens)} · ${hover.costUsd.toFixed(2)}</div>
          {hover.parts.map((p) => (
            <div key={p.key} className="flex items-center gap-2">
              <span className="size-2 rounded-sm" style={{ background: color.get(p.key) }} /> <span className="max-w-48 truncate">{p.key}</span>
              <span className="num ml-auto pl-3 font-medium">{tokenCount(p.tokens)} · ${p.costUsd.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
