// Every domain event type the SSE stream may name. A Record keyed by EventType, so a type added
// to src/domain/types.ts and not here fails the UI typecheck instead of going unheard.
import type { EventType } from '../../../src/domain/types.ts';

const ALL: Record<EventType, true> = {
  'job.queued': true, 'job.prioritized': true, 'job.held': true, 'job.approved': true, 'job.claimed': true,
  'job.started': true, 'job.progressed': true, 'job.finished': true, 'job.failed': true, 'job.cancelled': true,
  'job.requeued': true, 'job.reattached': true, 'job.reprioritized': true, 'job.respecified': true, 'lane.opened': true, 'lane.closed': true,
  'decision.made': true, 'question.asked': true, 'question.escalated': true, 'question.escalated_to_human': true,
  'question.answered': true, 'question.closed': true, 'question.dismissed': true, 'question.expired': true,
  'question.lapsed': true,
  'update.available': true, 'update.started': true, 'update.applied': true, 'update.failed': true,
  'plugin.installed': true, 'plugin.removed': true,
  'job.accepted': true, 'job.rejected': true, 'queue.ordered': true, 'queue.gate_changed': true,
  'job.claimed_by_operator': true,
  'job.rerun': true,
  'job.dismissed': true,
  'job.unassigned': true, 'job.reassigned': true,
  'job.work_kept': true, 'job.work_removed': true, 'job.cleanup_deferred': true, 'job.cleaned_up': true,
  'source.stalled': true, 'connected_account.expired': true, 'ui_session.ended': true,
};
export const EVENT_TYPES = Object.keys(ALL) as EventType[];

/** The types the lane spans and question waits read (the lane timeline, the Running card); an operator-led claim starts a span too. */
export const HISTORY_TYPES: EventType[] = [
  'job.started', 'job.reattached', 'job.claimed_by_operator', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued',
  'question.asked', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed',
];
