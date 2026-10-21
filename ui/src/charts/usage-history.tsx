// The usage graph (issues #385, #502): every shown line drawn as the dashboard cards draw theirs (sparkline.tsx) —
// a thin monotone line over a soft fill fading down — on a 0-100% axis over the stretch shown, each point at the
// middle of its graph step. A gap breaks a line; a reset of a usage window is a short tick at the axis foot in the
// line's colour; a marked moment (issue #688: a lane change) is a dotted line down the graph in its line's colour;
// hovering (or a tap) reads every shown line at that step, and names the marks there. Pinch, Ctrl/⌘ + scroll and a drag across
// zoom (use-graph-zoom.ts). d3 does the maths; React draws the SVG. Its height follows its width (issue #2354): shorter on
// a narrow panel, taller on a wide one, between MIN_HEIGHT and MAX_HEIGHT, unless a caller sets one.
import { area, curveMonotoneX, line, scaleLinear, scaleTime, timeFormat } from 'd3';
import { Fragment, useId, useMemo, useRef } from 'react';
import { useGraphZoom } from '@/hooks/use-graph-zoom';
import { useSize } from '@/hooks/use-size';
import { DASH_ARRAY, lineSegments, marksAt, valuesAt, type GraphLine, type GraphPoint, type Stretch } from '@/model/usage-history';
import { GridY, TimeAxis } from './axis';

const M = { top: 10, right: 16, bottom: 22, left: 34 };
const DAY = 86_400_000;
const MIN_HEIGHT = 170;
const MAX_HEIGHT = 300;
/** The graph's height for its width: a share of it, between the bounds. */
export const heightFor = (width: number) => Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, width * 0.4)));
const clock = timeFormat('%H:%M');
const weekdayClock = timeFormat('%a %H:%M');
const day = timeFormat('%b %d');
const dayClock = timeFormat('%b %d %H:%M');

export function UsageGraph({ lines, hidden, from, to, stepMs, maxMs, onZoom, height: fixed }: {
  lines: readonly GraphLine[]; hidden: ReadonlySet<string>; from: number; to: number; stepMs: number;
  /** The widest stretch zooming out reaches: the history kept. */
  maxMs: number; onZoom?: (s: Stretch) => void; height?: number;
}) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const height = fixed ?? heightFor(width);
  const plot = useRef<SVGRectElement>(null);
  const id = useId();
  const iw = Math.max(0, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const { shown: stretch, hoverT, drag, handlers } = useGraphZoom({ area: plot, width: iw, stretch: { from, to }, maxMs, ...(onZoom ? { onZoom } : {}) });
  const x = scaleTime().domain([stretch.from, stretch.to]).range([0, iw]);
  const y = scaleLinear().domain([0, 100]).range([ih, 0]);
  const mid = (t: number) => x(t + stepMs / 2);
  const ln = line<GraphPoint>().x((p) => mid(p.t)).y((p) => y(p.v * 100)).curve(curveMonotoneX);
  const ar = area<GraphPoint>().x((p) => mid(p.t)).y0(ih).y1((p) => y(p.v * 100)).curve(curveMonotoneX);
  const shown = lines.filter((l) => !hidden.has(l.key));
  const segments = useMemo(() => new Map(lines.map((l) => [l.key, lineSegments(l.series, stepMs)])), [lines, stepMs]);
  const span = stretch.to - stretch.from;
  const format = span <= DAY ? clock : span <= 4 * DAY ? weekdayClock : day;
  const hoverValues = hoverT === null ? [] : valuesAt(shown, hoverT, stepMs, hidden);
  const hoverMarks = hoverT === null ? [] : marksAt(shown, hoverT, stepMs, hidden);
  const gradient = (color: string) => `${id}-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <div ref={ref} className="relative w-full select-none" style={{ height, touchAction: 'pan-y' }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Usage over time: share of each limit used">
          <defs>
            <clipPath id={`${id}-plot`}><rect x={0} y={-M.top} width={iw} height={ih + M.top} /></clipPath>
            {[...new Set(shown.map((l) => l.color))].map((color) => (
              <linearGradient key={color} id={gradient(color)} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.2} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            <GridY scale={y} x0={0} x1={iw} ticks={4} />
            <g clipPath={`url(#${CSS.escape(`${id}-plot`)})`}>
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
                {(l.marks ?? []).map((m) => {
                  const mx = x(Date.parse(m.at));
                  return mx >= 0 && mx <= iw ? (
                    <line key={`mark-${m.at}`} data-graph-mark={m.at} x1={mx} x2={mx} y1={0} y2={ih} stroke={l.color} strokeOpacity={0.7} strokeWidth={1.25} strokeDasharray="2 3">
                      <title>{`${dayClock(new Date(m.at))} ${m.label}`}</title>
                    </line>
                  ) : null;
                })}
                {(segments.get(l.key) ?? []).map((seg, i) => (
                  <Fragment key={i}>
                    {seg.length === 1
                      ? <circle cx={mid(seg[0]!.t)} cy={y(seg[0]!.v * 100)} r={1.75} fill={l.color} />
                      : <>
                        <path d={ar(seg) ?? ''} fill={`url(#${CSS.escape(gradient(l.color))})`} />
                        <path d={ln(seg) ?? ''} fill="none" stroke={l.color} strokeWidth={1.5} strokeDasharray={DASH_ARRAY[l.dash]} />
                      </>}
                  </Fragment>
                ))}
              </g>
            ))}
            </g>
            <TimeAxis scale={x} y={ih} ticks={width < 400 ? 3 : width < 500 ? 4 : 8} format={format} />
            {drag && <rect data-slot="usage-graph-selection" x={Math.min(x(drag.from), x(drag.to))} y={0} width={Math.abs(x(drag.to) - x(drag.from))} height={ih} className="fill-foreground/10" />}
            {hoverT !== null && !drag && <line x1={x(hoverT)} x2={x(hoverT)} y1={0} y2={ih} className="stroke-foreground/30" />}
            <rect ref={plot} x={0} y={0} width={iw} height={ih} fill="transparent" className={onZoom ? 'cursor-crosshair' : undefined} {...handlers} />
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
          {hoverMarks.map(({ key, mark }) => (
            <div key={`${key}-${mark.at}`} data-slot="usage-graph-mark" className="mt-1 flex items-start gap-2 border-t pt-1">
              <LineSwatch line={{ color: lines.find((x) => x.key === key)!.color, dash: 'dotted' }} />
              <span><span className="num text-muted-foreground">{clock(new Date(mark.at))}</span> {mark.label}</span>
            </div>
          ))}
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
