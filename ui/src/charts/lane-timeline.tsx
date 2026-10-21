// What each lane ran, over a time window ending now: one row per lane, one bar per job run,
// coloured by how the run ended. Running bars grow with the clock. Jobs claimed as operator-led
// (issue #318) have a row of their own, `operator-led`: worked by hand, on no lane. A job sitting on a question is a
// hatched strip along the foot of the lane it asked from, until the question is answered. Each bar and strip links to its
// job's view (issue #433). With many lanes (issue #2354) it draws at most MAX_ROWS, the lanes that ran in the window
// first, until Show all; Hide idle lanes drops the lanes that ran nothing. On a narrow panel the label column takes at most
// LABEL_SHARE of the width, and a longer name is cut, its full name in its title.
import { scaleBand, scaleTime, timeFormat } from 'd3';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { COLOR, type Tone } from '@/components/status';
import { useSize } from '@/hooks/use-size';
import { duration } from '@/model/format';
import { jobHref } from '@/model/job';
import type { LaneSpan, QuestionWait, SpanOutcome } from '@/model/history';
import { TimeAxis } from './axis';

export const OUTCOME_TONE: Record<SpanOutcome, Tone> = {
  running: 'busy', 'operator-led': 'operator', finished: 'ok', failed: 'bad', cancelled: 'muted', requeued: 'warn', question: 'question', parked: 'muted', waiting: 'muted',
};
/** The legend swatch of a question wait: the strip's hatching. */
export const WAIT_SWATCH = `repeating-linear-gradient(135deg, ${COLOR.question} 0 2px, transparent 2px 4px)`;
/** The share of a lane's band a question wait's strip takes, at its foot. */
const WAIT_SHARE = 0.4;
const ROW = 26;
/** The most rows drawn before Show all. */
export const MAX_ROWS = 12;
/** The widest the label column gets, as a share of the width. */
const LABEL_SHARE = 0.3;
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
  const [showAll, setShowAll] = useState(false);
  const [hideIdle, setHideIdle] = useState(false);
  const all = useMemo(() => [...new Set([...lanes, ...spans.map((s) => s.laneId), ...waits.map((w) => w.laneId)])].sort(), [lanes, spans, waits]);
  const ran = useMemo(() => new Set([...spans, ...waits].filter((s) => s.end === null || s.end >= since).map((s) => s.laneId)), [spans, waits, since]);
  const idle = all.filter((l) => !ran.has(l)).length;
  const candidates = hideIdle ? all.filter((l) => ran.has(l)) : all;
  const capped = !showAll && candidates.length > MAX_ROWS;
  const rows = capped ? [...candidates.filter((l) => ran.has(l)), ...candidates.filter((l) => !ran.has(l))].slice(0, MAX_ROWS).sort() : candidates;
  const drawn = new Set(rows);
  const dim = (it: LaneSpan | QuestionWait) => hover !== null && hover.s !== it;
  const height = M.top + M.bottom + Math.max(1, rows.length) * ROW;
  const longest = Math.max(0, ...rows.map((l) => laneNameOf(l).length));
  const left = Math.min(Math.max(M.left, Math.ceil(longest * CHAR_PX) + 12), Math.max(M.left, Math.round(width * LABEL_SHARE)));
  const fits = Math.max(4, Math.floor((left - 12) / CHAR_PX));
  const label = (name: string) => (name.length > fits ? `${name.slice(0, fits - 1)}…` : name);
  const iw = Math.max(0, width - left - M.right);
  const x = scaleTime().domain([since, now]).range([0, iw]);
  const y = scaleBand<string>().domain(rows).range([0, rows.length * ROW]).paddingInner(0.3).paddingOuter(0.15);
  return (
    <div>
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
                <g key={laneId} data-lane-row={laneId}>
                  <rect x={0} y={y(laneId)} width={iw} height={y.bandwidth()} rx={3} className="fill-muted/40" />
                  <text x={-8} y={(y(laneId) ?? 0) + y.bandwidth() / 2} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
                    <title>{laneNameOf(laneId)}</title>{label(laneNameOf(laneId))}
                  </text>
                </g>
              ))}
              {spans.filter((s) => drawn.has(s.laneId)).map((s) => {
                const x0 = x(Math.max(s.start, since));
                const x1 = x(s.end ?? now);
                return (
                  <a key={`${s.jobId}-${s.start}`} href={jobHref(s.jobId)} aria-label={nameOf(s.jobId)}><rect x={x0} y={y(s.laneId)} width={Math.max(2, x1 - x0)} height={y.bandwidth()} rx={3}
                    fill={COLOR[OUTCOME_TONE[s.outcome]]} opacity={dim(s) ? 0.4 : s.end === null ? 0.95 : 0.75}
                    className={s.end === null ? 'animate-pulse' : undefined}
                    onMouseEnter={() => setHover({ kind: 'span', s })} onMouseLeave={() => setHover(null)} /></a>
                );
              })}
              {waits.filter((w) => drawn.has(w.laneId)).map((w) => {
                const x0 = x(Math.max(w.start, since));
                const x1 = x(w.end ?? now);
                const h = y.bandwidth() * WAIT_SHARE;
                return (
                  <a key={`wait-${w.jobId}-${w.start}`} href={jobHref(w.jobId)} aria-label={nameOf(w.jobId)}><rect data-wait={w.how} x={x0} y={(y(w.laneId) ?? 0) + y.bandwidth() - h} width={Math.max(2, x1 - x0)} height={h} rx={2}
                    fill={`url(#${hatch})`} stroke={COLOR.question} strokeWidth={1} opacity={dim(w) ? 0.4 : 1}
                    onMouseEnter={() => setHover({ kind: 'wait', s: w })} onMouseLeave={() => setHover(null)} /></a>
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
      {(idle > 0 || candidates.length > MAX_ROWS) && (
        <div data-slot="lane-timeline-rows" className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {capped && <span>{candidates.length - rows.length} more lanes not drawn</span>}
          {candidates.length > MAX_ROWS && (
            <Button type="button" size="xs" variant="ghost" onClick={() => setShowAll((a) => !a)}>{showAll ? 'Show fewer lanes' : `Show all ${candidates.length} lanes`}</Button>
          )}
          {idle > 0 && (
            <Button type="button" size="xs" variant="ghost" aria-pressed={hideIdle} onClick={() => setHideIdle((h) => !h)}>{hideIdle ? `Show ${idle} idle lanes` : `Hide ${idle} idle lanes`}</Button>
          )}
        </div>
      )}
    </div>
  );
}
