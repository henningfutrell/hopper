// A usage reading as a 240° arc: used of limit, coloured past the soft and hard marks.
import { arc } from 'd3';
import { COLOR, type Tone } from '@/components/status';

const START = (-2 * Math.PI) / 3;
const SWEEP = (4 * Math.PI) / 3;

export const usageTone = (f: number): Tone => (f >= 0.95 ? 'bad' : f >= 0.7 ? 'warn' : 'ok');

export function Gauge({ fraction, size = 112, label, sub }: { fraction: number; size?: number; label: string; sub?: string }) {
  const f = Math.max(0, Math.min(1, fraction));
  const r = size / 2;
  const a = arc<{ e: number }>().innerRadius(r - 9).outerRadius(r).cornerRadius(5).startAngle(START).endAngle((d) => START + SWEEP * d.e);
  const tick = (at: number) => {
    const ang = START + SWEEP * at - Math.PI / 2;
    return { x1: Math.cos(ang) * (r - 12), y1: Math.sin(ang) * (r - 12), x2: Math.cos(ang) * (r + 1), y2: Math.sin(ang) * (r + 1) };
  };
  return (
    <svg width={size} height={size * 0.86} viewBox={`${-r} ${-r} ${size} ${size * 0.86}`} role="img" aria-label={`${label}: ${Math.round(f * 100)}%`}>
      <path d={a({ e: 1 }) ?? ''} className="fill-muted" />
      {f > 0 && <path d={a({ e: f }) ?? ''} fill={COLOR[usageTone(f)]} />}
      {[0.7, 0.95].map((m) => <line key={m} {...tick(m)} className="stroke-background" strokeWidth={2} />)}
      <text y={-2} textAnchor="middle" className="num fill-foreground text-[20px] font-semibold">{Math.round(f * 100)}%</text>
      {sub && <text y={16} textAnchor="middle" className="num fill-muted-foreground text-[10px]">{sub}</text>}
    </svg>
  );
}
