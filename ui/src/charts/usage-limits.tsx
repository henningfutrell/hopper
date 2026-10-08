// The usage limits graph (issue #522): the throttle line over the last day on a 0-100% axis, laid over the three
// bands it can sit in — free below the soft limit, soft up to the hard limit, hard above — shaded in their tones.
// The line takes the tone of the band each stretch of it is in, so moving a limit recolours the past at once; the
// dot at its end is usage now. Each limit is a dashed rule with a handle on the right: drag it, or press anywhere
// on the graph to move the nearer limit there, or focus it and use the arrow keys (Shift: 5%). d3 does the maths;
// React draws the SVG.
import { area, curveMonotoneX, line, scaleLinear, scaleTime } from 'd3';
import { useId, useRef, useState } from 'react';
import { COLOR } from '@/components/status';
import { useSize } from '@/hooks/use-size';
import { bandAt, dragLimit, type LimitBand, type LimitName } from '@/model/usage-limits';
import type { GraphPoint } from '@/model/usage-history';
import type { UsageLimitPair } from '@/model/wire';

const M = { top: 12, right: 76, bottom: 10, left: 34 };
const BAND_COLOR: Record<LimitBand, string> = { free: COLOR.ok, soft: COLOR.warn, hard: COLOR.bad };
const LIMIT_LABEL: Record<LimitName, string> = { soft: 'Soft', hard: 'Hard' };
const pct = (f: number) => `${Math.round(f * 100)}%`;

export function UsageLimitsGraph({ points, now, from, to, limits, onChange, height = 220 }: {
  points: readonly GraphPoint[];
  /** The throttle fraction now, drawn as the line's last point. */
  now: number;
  from: number; to: number;
  limits: UsageLimitPair;
  /** Absent: read only. */
  onChange?: (l: UsageLimitPair) => void;
  height?: number;
}) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const plot = useRef<SVGRectElement>(null);
  const [dragging, setDragging] = useState<LimitName | null>(null);
  const id = useId();
  const iw = Math.max(0, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const x = scaleTime().domain([from, to]).range([0, iw]);
  const y = scaleLinear().domain([0, 1]).range([ih, 0]).clamp(true);
  const shown = [...points.filter((p) => p.t >= from && p.t < to), { t: to, v: now }];
  const ln = line<GraphPoint>().x((p) => x(p.t)).y((p) => y(p.v)).curve(curveMonotoneX);
  const ar = area<GraphPoint>().x((p) => x(p.t)).y0(ih).y1((p) => y(p.v)).curve(curveMonotoneX);
  const nowBand = bandAt(now, limits);
  const editable = onChange !== undefined;

  const valueAt = (clientY: number) => {
    const box = plot.current?.getBoundingClientRect();
    return box ? 1 - (clientY - box.top) / box.height : 0;
  };
  const move = (which: LimitName, clientY: number) => onChange?.(dragLimit(limits, which, valueAt(clientY)));
  const nearer = (v: number): LimitName => (Math.abs(v - limits.soft) <= Math.abs(v - limits.hard) ? 'soft' : 'hard');
  const grab = (which: LimitName) => (e: React.PointerEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDragging(which);
    move(which, e.clientY);
  };
  const drag = (e: React.PointerEvent) => { if (dragging) move(dragging, e.clientY); };
  const drop = () => setDragging(null);
  const key = (which: LimitName) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const by = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? step : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -step : 0;
    if (!by || !onChange) return;
    e.preventDefault();
    onChange(dragLimit(limits, which, limits[which] + by));
  };

  // The line's tone per band: a vertical gradient with hard stops at the limits.
  const stops: [number, LimitBand][] = [[0, 'free'], [limits.soft, 'free'], [limits.soft, 'soft'], [limits.hard, 'soft'], [limits.hard, 'hard'], [1, 'hard']];
  const bands: [LimitBand, number, number][] = [['free', 0, limits.soft], ['soft', limits.soft, limits.hard], ['hard', limits.hard, 1]];
  return (
    <div ref={ref} className="relative w-full select-none" style={{ height, touchAction: dragging ? 'none' : 'pan-y' }} data-slot="usage-limits-graph">
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label={`Usage now ${pct(now)}: soft limit ${pct(limits.soft)}, hard limit ${pct(limits.hard)}`}
          onPointerMove={drag} onPointerUp={drop} onPointerCancel={drop}>
          <defs>
            <linearGradient id={`${id}-tone`} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={y(0)} y2={y(1)}>
              {stops.map(([at, band], i) => <stop key={i} offset={at} stopColor={BAND_COLOR[band]} />)}
            </linearGradient>
            <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={BAND_COLOR[nowBand]} stopOpacity={0.22} />
              <stop offset="100%" stopColor={BAND_COLOR[nowBand]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <g transform={`translate(${M.left},${M.top})`}>
            {bands.map(([band, lo, hi]) => (
              <rect key={band} data-band={band} x={0} width={iw} y={y(hi)} height={Math.max(0, y(lo) - y(hi))} fill={BAND_COLOR[band]}
                fillOpacity={band === nowBand ? 0.1 : 0.045} className="transition-[fill-opacity] duration-300" />
            ))}
            {bands.map(([band, lo, hi]) => (y(lo) - y(hi) >= 16 ? (
              <text key={band} x={8} y={y(hi) + 12} className="fill-muted-foreground text-[10px] font-medium tracking-[0.08em] uppercase" pointerEvents="none">{band}</text>
            ) : null))}
            {[0, 0.5, 1].map((t) => (
              <text key={t} x={-6} y={y(t)} dy="0.32em" textAnchor="end" className="num fill-muted-foreground text-[10px]">{Math.round(t * 100)}</text>
            ))}
            <path d={ar(shown) ?? ''} fill={`url(#${CSS.escape(`${id}-fill`)})`} />
            <path d={ln(shown) ?? ''} fill="none" stroke={`url(#${CSS.escape(`${id}-tone`)})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <rect ref={plot} x={0} y={0} width={iw} height={ih} fill="transparent" className={editable ? 'cursor-ns-resize' : undefined}
              onPointerDown={(e) => grab(nearer(valueAt(e.clientY)))(e)} />
            <g data-slot="usage-now" transform={`translate(${x(to)},${y(now)})`} pointerEvents="none">
              <circle r={9} fill={BAND_COLOR[nowBand]} opacity={0.18} className="animate-ping [transform-box:fill-box] [transform-origin:center]" />
              <circle r={4} fill={BAND_COLOR[nowBand]} className="stroke-background" strokeWidth={2} />
            </g>
            {(['soft', 'hard'] as const).map((which) => {
              const ly = y(limits[which]);
              const band: LimitBand = which === 'soft' ? 'soft' : 'hard';
              return (
                <g key={which} data-limit={which} transform={`translate(0,${ly})`} className={dragging === which ? undefined : 'transition-transform duration-150 ease-out'}>
                  <line x1={0} x2={iw} stroke={BAND_COLOR[band]} strokeWidth={dragging === which ? 1.5 : 1} strokeDasharray="4 4" pointerEvents="none" />
                  {editable && <rect x={0} y={-6} width={iw} height={12} fill="transparent" className="cursor-ns-resize" onPointerDown={grab(which)} />}
                  <g transform={`translate(${iw + 8},0)`} role={editable ? 'slider' : 'img'} tabIndex={editable ? 0 : undefined}
                    aria-label={`${LIMIT_LABEL[which]} limit`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(limits[which] * 100)}
                    aria-valuetext={pct(limits[which])} onKeyDown={key(which)} onPointerDown={grab(which)}
                    className={editable ? 'cursor-ns-resize outline-none [&:focus-visible>rect]:stroke-foreground' : undefined}>
                    <rect x={0} y={-10} width={62} height={20} rx={10} fill={BAND_COLOR[band]} className="stroke-transparent" strokeWidth={2} />
                    <text x={31} dy="0.35em" textAnchor="middle" className="num fill-background text-[11px] font-semibold" pointerEvents="none">
                      {LIMIT_LABEL[which]} {pct(limits[which])}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
