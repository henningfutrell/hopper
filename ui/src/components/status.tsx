// Status → colour, one mapping for every badge, dot, bar and chart mark.
import { cn } from '@/lib/utils';

export type Tone = 'busy' | 'ok' | 'bad' | 'warn' | 'question' | 'operator' | 'muted';

const TONE: Record<string, Tone> = {
  running: 'busy', claimed: 'busy', busy: 'busy', live: 'ok',
  finished: 'ok', delivered: 'ok', accepted: 'ok', online: 'ok',
  failed: 'bad', error: 'bad', offline: 'bad',
  held: 'warn', draining: 'warn', retrying: 'warn', pending: 'warn', starting: 'warn', escalated: 'warn', reconnecting: 'warn', drafted: 'warn',
  waiting_answer: 'question', question: 'question', human: 'question',
  operator_led: 'operator', 'operator-led': 'operator',
};
export const toneOf = (status: string): Tone => TONE[status] ?? 'muted';

const BADGE: Record<Tone, string> = {
  busy: 'bg-busy/10 text-busy border-busy/25',
  ok: 'bg-ok/10 text-ok border-ok/25',
  bad: 'bg-bad/10 text-bad border-bad/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  question: 'bg-question/10 text-question border-question/25',
  operator: 'bg-operator/10 text-operator border-operator/25',
  muted: 'bg-muted/60 text-muted-foreground border-border',
};
const DOT: Record<Tone, string> = { busy: 'bg-busy', ok: 'bg-ok', bad: 'bg-bad', warn: 'bg-warn', question: 'bg-question', operator: 'bg-operator', muted: 'bg-muted-foreground/50' };
export const TEXT: Record<Tone, string> = { busy: 'text-busy', ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', question: 'text-question', operator: 'text-operator', muted: 'text-muted-foreground' };
/** CSS colour per tone, for SVG fills. */
export const COLOR: Record<Tone, string> = {
  busy: 'var(--busy)', ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', question: 'var(--question)', operator: 'var(--operator)', muted: 'var(--muted-foreground)',
};

export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', DOT[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', DOT[tone])} />
    </span>
  );
}

export function StatusBadge({ status, label, tone, className }: { status: string; label?: string; tone?: Tone; className?: string }) {
  const t = tone ?? toneOf(status);
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[11px] font-medium whitespace-nowrap', BADGE[t], className)}>
      {label ?? status.replace('_', ' ')}
    </span>
  );
}
