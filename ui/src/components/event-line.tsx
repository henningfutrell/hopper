// One event as one line: time, type (coloured by what ended or started), and its subject.
import { clock } from '@/model/format';
import { subjectOf } from '@/model/board';
import type { DomainEvent, MachineView } from '@/model/wire';
import { TEXT, type Tone } from '@/components/status';
import { cn } from '@/lib/utils';

const TYPE_TONE: Record<string, Tone> = {
  'job.started': 'busy', 'job.claimed': 'busy', 'job.reattached': 'busy', 'job.finished': 'ok', 'job.failed': 'bad',
  'job.held': 'warn', 'job.requeued': 'warn', 'question.asked': 'question', 'question.escalated': 'question',
  'question.answered': 'ok', 'question.closed': 'warn', 'question.dismissed': 'muted', 'question.expired': 'bad', 'lane.opened': 'busy',
  'update.available': 'warn', 'update.started': 'busy', 'update.applied': 'ok', 'update.failed': 'bad',
  'plugin.installed': 'ok', 'job.accepted': 'ok', 'job.rejected': 'muted', 'queue.gate_changed': 'warn',
};
export const eventTone = (type: string): Tone => TYPE_TONE[type] ?? 'muted';

export function detailOf(e: DomainEvent): string {
  const d = e.data as Record<string, unknown>;
  for (const k of ['error', 'reason', 'message', 'target', 'by', 'mode']) if (typeof d[k] === 'string' && d[k]) return String(d[k]);
  if (e.type.startsWith('update.') && typeof d.to === 'string') return `${typeof d.ref === 'string' ? `${d.ref} ` : ''}${d.to.slice(0, 7)}`;
  return '';
}

export function EventLine({ e, nameOf, machines, className }: { e: DomainEvent; nameOf: (jobId: string) => string; machines: readonly Pick<MachineView, 'id' | 'label'>[]; className?: string }) {
  const detail = detailOf(e);
  const subject = subjectOf(e, nameOf, machines);
  return (
    <div className={cn('grid grid-cols-[4.5rem_8.5rem_minmax(0,1fr)] items-baseline gap-2 text-xs', className)}>
      <span className="num font-mono text-muted-foreground/80" title={e.at}>{clock(e.at)}</span>
      <span className={cn('truncate font-mono font-medium', TEXT[eventTone(e.type)])}>{e.type}</span>
      <span className="min-w-0 truncate" title={detail ? `${subject} — ${detail}` : subject}>
        {subject}{detail && <span className="text-muted-foreground"> — {detail}</span>}
      </span>
    </div>
  );
}
