// What each lane ran, over a time window ending now: one row per lane, one bar per job run,
// coloured by how the run ended. Running bars grow with the clock. A job sitting on a question is a
// hatched strip along the foot of the lane it asked from, until the question is answered.
import { scaleBand, scaleTime, timeFormat } from 'd3';
import { useId, useMemo, useState } from 'react';
import { COLOR, type Tone } from '@/components/status';
import { useSize } from '@/hooks/use-size';
import { duration } from '@/model/format';
import type { LaneSpan, QuestionWait, SpanOutcome } from '@/model/history';
import { TimeAxis } from './axis';

export const OUTCOME_TONE: Record<SpanOutcome, Tone> = {
  running: 'busy', finished: 'ok', failed: 'bad', cancelled: 'muted', requeued: 'warn', question: 'question',
};
/** The legend swatch of a question wait: the strip's hatching. */
export const WAIT_SWATCH = `repeating-linear-gradient(135deg, ${COLOR.question} 0 2px, transparent 2px 4px)`;
/** The share of a lane's band a question wait's strip takes, at its foot. */
const WAIT_SHARE = 0.4;
const ROW = 26;
const M = { top: 4, right: 16, bottom: 22, left: 64 };
const hm = timeFormat('%H:%M');

/** Width of one character of a row label (10px monospace), to fit the label column to the longest name. */
const CHAR_PX = 6.1;

type Hovered = { kind: 'span'; s: LaneSpan } | { kind: 'wait'; s: QuestionWait };

export function LaneTimeline({ spans, waits, now, windowMs, lanes, nameOf, laneNameOf }: {
  /** From `useLaneSpans`: the event log reconciled with the job store. */
  spans: LaneSpan[];
  /** From `useQuestionWaits`: when jobs sat on a question, on the lane they asked from. */
  waits: QuestionWait[]; now: number; windowMs: number; lanes: string[]; nameOf: (jobId: string) => string;
  /** A lane's name with its machine (issue #166): `lane-1` alone is on every machine. */
  laneNameOf: (laneId: string) => string;
}) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hovered | null>(null);
  const hatch = `hatch-${useId()}`;
  const since = now - windowMs;
  const rows = useMemo(() => [...new Set([...lanes, ...spans.map((s) => s.laneId), ...waits.map((w) => w.laneId)])].sort(), [lanes, spans, waits]);
  const dim = (it: LaneSpan | QuestionWait) => hover !== null && hover.s !== it;
  const height = M.top + M.bottom + Math.max(1, rows.length) * ROW;
  const longest = Math.max(0, ...rows.map((l) => laneNameOf(l).length));
  const left = Math.min(Math.max(M.left, Math.ceil(longest * CHAR_PX) + 12), Math.round(width * 0.45));
  const iw = Math.max(0, width - left - M.right);
  const x = scaleTime().domain([since, now]).range([0, iw]);
  const y = scaleBand<string>().domain(rows).range([0, rows.length * ROW]).paddingInner(0.3).paddingOuter(0.15);
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Lane activity timeline">
          <defs>
            <pattern id={hatch} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={4} height={4} fill={COLOR.question} fillOpacity={0.35} />
              <rect width={2} height={4} fill={COLOR.question} />
            </pattern>
          </defs>
          <g transform={`translate(${left},${M.top})`}>
            {rows.map((laneId) => (
              <g key={laneId}>
                <rect x={0} y={y(laneId)} width={iw} height={y.bandwidth()} rx={3} className="fill-muted/40" />
                <text x={-8} y={(y(laneId) ?? 0) + y.bandwidth() / 2} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
                  <title>{laneNameOf(laneId)}</title>{laneNameOf(laneId)}
                </text>
              </g>
            ))}
            {spans.map((s) => {
              const x0 = x(Math.max(s.start, since));
              const x1 = x(s.end ?? now);
              return (
                <rect key={`${s.jobId}-${s.start}`} x={x0} y={y(s.laneId)} width={Math.max(2, x1 - x0)} height={y.bandwidth()} rx={3}
                  fill={COLOR[OUTCOME_TONE[s.outcome]]} opacity={dim(s) ? 0.4 : s.outcome === 'running' ? 0.95 : 0.75}
                  className={s.outcome === 'running' ? 'animate-pulse' : undefined}
                  onMouseEnter={() => setHover({ kind: 'span', s })} onMouseLeave={() => setHover(null)} />
              );
            })}
            {waits.map((w) => {
              const x0 = x(Math.max(w.start, since));
              const x1 = x(w.end ?? now);
              const h = y.bandwidth() * WAIT_SHARE;
              return (
                <rect key={`wait-${w.jobId}-${w.start}`} data-wait={w.how} x={x0} y={(y(w.laneId) ?? 0) + y.bandwidth() - h} width={Math.max(2, x1 - x0)} height={h} rx={2}
                  fill={`url(#${hatch})`} stroke={COLOR.question} strokeWidth={1} opacity={dim(w) ? 0.4 : 1}
                  onMouseEnter={() => setHover({ kind: 'wait', s: w })} onMouseLeave={() => setHover(null)} />
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
          <div className="truncate font-medium">{nameOf(hover.s.jobId)}</div>
          <div className="num text-muted-foreground">
            {laneNameOf(hover.s.laneId)} · {hm(new Date(hover.s.start))}–{hover.s.end ? hm(new Date(hover.s.end)) : 'now'} · {duration(((hover.s.end ?? now) - hover.s.start) / 1000)} · {hover.kind === 'span' ? hover.s.outcome : hover.s.how === 'waiting' ? 'waiting answer' : `on a question, ${hover.s.how}`}
          </div>
        </div>
      )}
    </div>
  );
}
