// One event as one line: time, type (coloured by what ended or started), and its subject.
import { clock } from '@/model/format';
import { subjectOf } from '@/model/board';
import { artifactCreatedDetail } from '@/model/artifacts';
import { pickedEventDetail } from '@/model/minor-decisions';
import type { DomainEvent, MachineView } from '@/model/wire';
import { TEXT, type Tone } from '@/components/status';
import { cn } from '@/lib/utils';

const TYPE_TONE: Record<string, Tone> = {
  'job.started': 'busy', 'job.claimed': 'busy', 'job.reattached': 'busy', 'job.finished': 'ok', 'job.failed': 'bad',
  'job.held': 'warn', 'job.requeued': 'warn', 'question.asked': 'question', 'question.escalated': 'question', 'question.escalated_to_human': 'question',
  'question.answered': 'ok', 'question.closed': 'warn', 'question.dismissed': 'muted', 'question.expired': 'bad', 'question.lapsed': 'warn', 'lane.opened': 'busy',
  'update.available': 'warn', 'update.started': 'busy', 'update.applied': 'ok', 'update.failed': 'bad',
  'plugin.installed': 'ok', 'job.accepted': 'ok', 'job.rejected': 'muted', 'queue.gate_changed': 'warn', 'usage.limits_changed': 'warn',
  'priority_lanes.changed': 'warn', 'priority_lanes.settings_changed': 'warn',
  'job.claimed_by_operator': 'operator',
  'minor_decision.picked': 'question', 'minor_decision.overridden': 'warn',
  'job.phase_changed': 'question', 'job.forked': 'question', 'job.fork_resolved': 'ok', 'phase_shifts.settings_changed': 'warn',
  'question.corrected': 'warn', 'auto_answer.settings_changed': 'warn', 'auto_park.settings_changed': 'warn',
  'job.rerun': 'warn', 'job.unassigned': 'warn', 'job.work_kept': 'warn', 'job.cleanup_deferred': 'warn',
  'github_proxy.done': 'ok', 'github_proxy.refused': 'warn', 'github_proxy.failed': 'bad',
  'skill.loaded': 'ok', 'skill.refused': 'warn',
};
export const eventTone = (type: string): Tone => TYPE_TONE[type] ?? 'muted';

export function detailOf(e: DomainEvent): string {
  const d = e.data as Record<string, unknown>;
  if (e.type === 'minor_decision.picked') return pickedEventDetail(d);
  // Phase shifts (issue #548): from which phase to which, and why; a fork, what it is for.
  if (e.type === 'job.phase_changed') return `${String(d.from)} → ${String(d.to)}: ${String(d.reason)}`;
  if (e.type === 'job.forked') return `${String(d.to)} forked as ${String(d.forkId).slice(0, 8)}${typeof d.note === 'string' ? `: ${d.note}` : ''}`;
  // The GitHub proxy (issue #563): what the hopper did on GitHub for the job, where, or why not.
  if (e.type === 'github_proxy.done') return `${String(d.op)} ${String(d.repo)}#${String(d.number)}: ${String(d.url)}`;
  if (e.type === 'github_proxy.refused') return `${typeof d.op === 'string' ? `${d.op} ` : ''}refused: ${String(d.reason)}`;
  if (e.type === 'github_proxy.failed') return `${String(d.op)} ${String(d.repo)}: ${String(d.error)}`;
  // Skills (issue #582): what the job asked the hopper to set up, and the answer.
  if (e.type === 'skill.listed') return 'asked what the hopper can set up';
  if (e.type === 'skill.loaded') return `loaded ${String(d.skill)}${typeof d.asset === 'string' ? ` for ${d.asset}` : ''}`;
  if (e.type === 'skill.refused') return `${String(d.skill)}: no: ${String(d.reason)}`;
  if (e.type === 'artifact.created') return artifactCreatedDetail(d);
  if (e.type === 'job.fork_resolved') return `fork ${String(d.forkId).slice(0, 8)} ${d.decision === 'accept' ? 'accepted' : 'rejected'}${d.delivered ? ': answered the question' : ''}`;
  for (const k of ['error', 'reason', 'message', 'target', 'by', 'mode', 'assignee']) if (typeof d[k] === 'string' && d[k]) return String(d[k]);
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
