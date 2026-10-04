// One event as one line: time, type (coloured by what ended or started), and its subject.
import { clock } from '@/model/format';
import type { DomainEvent } from '@/model/wire';
import { TEXT, type Tone } from '@/components/status';
import { cn } from '@/lib/utils';

const TYPE_TONE: Record<string, Tone> = {
  'job.started': 'busy', 'job.claimed': 'busy', 'job.reattached': 'busy', 'job.finished': 'ok', 'job.failed': 'bad',
  'job.held': 'warn', 'job.requeued': 'warn', 'question.asked': 'question', 'question.escalated': 'question',
  'question.answered': 'ok', 'question.closed': 'warn', 'question.expired': 'bad', 'lane.opened': 'busy', 'router.mode_changed': 'warn',
};
export const eventTone = (type: string): Tone => TYPE_TONE[type] ?? 'muted';

export function subjectOf(e: DomainEvent, nameOf: (jobId: string) => string): string {
  if (e.jobId) return nameOf(e.jobId);
  return e.laneId ?? e.machineId ?? e.decisionId?.slice(0, 8) ?? '';
}

export function detailOf(e: DomainEvent): string {
  const d = e.data as Record<string, unknown>;
  for (const k of ['error', 'reason', 'message', 'target', 'by', 'mode']) if (typeof d[k] === 'string' && d[k]) return String(d[k]);
  return '';
}

export function EventLine({ e, nameOf, className }: { e: DomainEvent; nameOf: (jobId: string) => string; className?: string }) {
  const detail = detailOf(e);
  return (
    <div className={cn('grid grid-cols-[4.5rem_8.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs', className)}>
      <span className="num font-mono text-muted-foreground/80" title={e.at}>{clock(e.at)}</span>
      <span className={cn('truncate font-mono font-medium', TEXT[eventTone(e.type)])}>{e.type}</span>
      <span className="min-w-0 truncate" title={detail ? `${subjectOf(e, nameOf)} — ${detail}` : subjectOf(e, nameOf)}>
        {subjectOf(e, nameOf)}{detail && <span className="text-muted-foreground"> — {detail}</span>}
      </span>
    </div>
  );
}
