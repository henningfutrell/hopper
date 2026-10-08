// The usage graph (issue #385): every shown line drawn as the dashboard cards draw theirs (sparkline.tsx) —
// a thin monotone line over a soft fill fading down — on a 0-100% axis over the graph range. A gap breaks
// a line; a reset of a usage window is a short tick at the axis foot in the line's colour; hovering reads every shown line at
// that step. d3 does the maths; React draws the SVG.
import { area, curveMonotoneX, line, scaleLinear, scaleTime, timeFormat } from 'd3';
import { Fragment, useId, useMemo, useState } from 'react';
import { useSize } from '@/hooks/use-size';
import { DASH_ARRAY, lineSegments, valuesAt, type GraphLine, type GraphPoint } from '@/model/usage-history';
import { GridY, TimeAxis } from './axis';

const M = { top: 10, right: 16, bottom: 22, left: 34 };
const DAY = 86_400_000;
const clock = timeFormat('%H:%M');
const day = timeFormat('%b %d');
const dayClock = timeFormat('%b %d %H:%M');

export function UsageGraph({ lines, hidden, from, to, stepMs, height = 240 }: {
  lines: readonly GraphLine[]; hidden: ReadonlySet<string>; from: number; to: number; stepMs: number; height?: number;
}) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const id = useId();
  const [hoverT, setHoverT] = useState<number | null>(null);
  const iw = Math.max(0, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const x = scaleTime().domain([from, to]).range([0, iw]);
  const y = scaleLinear().domain([0, 100]).range([ih, 0]);
  const ln = line<GraphPoint>().x((p) => x(p.t)).y((p) => y(p.v * 100)).curve(curveMonotoneX);
  const ar = area<GraphPoint>().x((p) => x(p.t)).y0(ih).y1((p) => y(p.v * 100)).curve(curveMonotoneX);
  const shown = lines.filter((l) => !hidden.has(l.key));
  const segments = useMemo(() => new Map(lines.map((l) => [l.key, lineSegments(l.series, stepMs)])), [lines, stepMs]);
  const format = to - from <= DAY ? clock : day;
  const hoverValues = hoverT === null ? [] : valuesAt(shown, hoverT, stepMs, hidden);
  const gradient = (color: string) => `${id}-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Usage over time: share of each limit used">
          <defs>
            {[...new Set(shown.map((l) => l.color))].map((color) => (
              <linearGradient key={color} id={gradient(color)} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            <GridY scale={y} x0={0} x1={iw} ticks={4} />
            {shown.map((l) => (
              <g key={l.key} data-usage-line={l.key}>
                {l.series.resets.map((r) => {
                  const rx = x(Date.parse(r));
                  return rx >= 0 && rx <= iw ? (
                    <line key={r} data-usage-reset={r} x1={rx} x2={rx} y1={ih - 7} y2={ih} stroke={l.color} strokeOpacity={0.85} strokeWidth={1.5}>
                      <title>{`${l.label} reset ${dayClock(new Date(r))}`}</title>
                    </line>
                  ) : null;
                })}
                {(segments.get(l.key) ?? []).map((seg, i) => (
                  <Fragment key={i}>
                    {seg.length === 1
                      ? <circle cx={x(seg[0]!.t)} cy={y(seg[0]!.v * 100)} r={1.75} fill={l.color} />
                      : <>
                        <path d={ar(seg) ?? ''} fill={`url(#${CSS.escape(gradient(l.color))})`} />
                        <path d={ln(seg) ?? ''} fill="none" stroke={l.color} strokeWidth={1.5} strokeDasharray={DASH_ARRAY[l.dash]} />
                      </>}
                  </Fragment>
                ))}
              </g>
            ))}
            <TimeAxis scale={x} y={ih} ticks={width < 500 ? 4 : 8} format={format} />
            {hoverT !== null && <line x1={x(hoverT)} x2={x(hoverT)} y1={0} y2={ih} className="stroke-foreground/30" />}
            <rect x={0} y={0} width={iw} height={ih} fill="transparent"
              onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoverT(+x.invert(e.clientX - r.left)); }}
              onMouseLeave={() => setHoverT(null)} />
          </g>
        </svg>
      )}
      {hoverT !== null && (
        <div data-slot="usage-graph-hover" className="pointer-events-none absolute top-1 right-1 max-w-[70%] rounded-md border bg-popover/95 px-2.5 py-1.5 text-xs shadow-md backdrop-blur">
          <div className="num mb-1 text-muted-foreground">{dayClock(new Date(hoverT))}</div>
          {hoverValues.length ? hoverValues.map(({ key, v }) => {
            const l = lines.find((x) => x.key === key)!;
            return (
              <div key={key} className="flex items-center gap-2">
                <LineSwatch line={l} /> <span className="truncate">{l.label}</span><span className="num ml-auto pl-3 font-medium">{Math.round(v * 100)}%</span>
              </div>
            );
          }) : <div className="text-muted-foreground">no sample here</div>}
        </div>
      )}
    </div>
  );
}

/** A short stroke in the line's colour and dash: the legend's and the hover's key. */
export function LineSwatch({ line: l }: { line: Pick<GraphLine, 'color' | 'dash'> }) {
  return (
    <svg width={18} height={8} aria-hidden className="shrink-0">
      <line x1={1} x2={17} y1={4} y2={4} stroke={l.color} strokeWidth={2} strokeDasharray={DASH_ARRAY[l.dash]} />
    </svg>
  );
}
