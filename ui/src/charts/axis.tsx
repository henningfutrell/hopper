// Axes drawn by React from d3 scale ticks: no DOM handed to d3, so React owns every node.
import type { ScaleLinear, ScaleTime } from 'd3';

const TICK = 'fill-muted-foreground text-[10px] num';

export function TimeAxis({ scale, y, ticks = 6, format }: { scale: ScaleTime<number, number>; y: number; ticks?: number; format: (d: Date) => string }) {
  return (
    <g transform={`translate(0,${y})`}>
      {scale.ticks(ticks).map((t) => (
        <text key={+t} x={scale(t)} y={14} textAnchor="middle" className={TICK}>{format(t)}</text>
      ))}
    </g>
  );
}

export function GridY({ scale, x0, x1, ticks = 4 }: { scale: ScaleLinear<number, number>; x0: number; x1: number; ticks?: number }) {
  return (
    <g>
      {scale.ticks(ticks).filter(Number.isInteger).map((t) => (
        <g key={t}>
          <line x1={x0} x2={x1} y1={scale(t)} y2={scale(t)} className="stroke-border" strokeDasharray={t === 0 ? undefined : '2 3'} />
          <text x={x0 - 6} y={scale(t)} dy="0.32em" textAnchor="end" className={TICK}>{t}</text>
        </g>
      ))}
    </g>
  );
}
