// A tiny area + line: the shape of a series, no axes. d3 does the maths; React draws the SVG.
import { area, curveMonotoneX, line, max, scaleLinear } from 'd3';
import { useId } from 'react';
import { useSize } from '@/hooks/use-size';

export function Sparkline({ values, color, height = 32 }: { values: number[]; color: string; height?: number }) {
  const [ref, { width }] = useSize<HTMLDivElement>();
  const id = useId();
  const x = scaleLinear().domain([0, Math.max(1, values.length - 1)]).range([1, Math.max(1, width - 1)]);
  const y = scaleLinear().domain([0, Math.max(1, max(values) ?? 0)]).range([height - 2, 2]);
  const ln = line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(curveMonotoneX);
  const ar = area<number>().x((_, i) => x(i)).y0(height).y1((v) => y(v)).curve(curveMonotoneX);
  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={ar(values) ?? ''} fill={`url(#${CSS.escape(id)})`} />
          <path d={ln(values) ?? ''} fill="none" stroke={color} strokeWidth={1.5} />
        </svg>
      )}
    </div>
  );
}
