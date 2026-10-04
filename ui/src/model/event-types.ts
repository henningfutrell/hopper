// Every domain event type the SSE stream may name. A Record keyed by EventType, so a type added
// to src/domain/types.ts and not here fails the UI typecheck instead of going unheard.
import type { EventType } from '../../../src/domain/types.ts';

const ALL: Record<EventType, true> = {
  'job.queued': true, 'job.prioritized': true, 'job.held': true, 'job.approved': true, 'job.claimed': true,
  'job.started': true, 'job.progressed': true, 'job.finished': true, 'job.failed': true, 'job.cancelled': true,
  'job.requeued': true, 'job.reattached': true, 'job.reprioritized': true, 'lane.opened': true, 'lane.closed': true,
  'decision.made': true, 'router.mode_changed': true, 'question.asked': true, 'question.escalated': true,
  'question.answered': true, 'question.expired': true,
};
export const EVENT_TYPES = Object.keys(ALL) as EventType[];

/** The types the charts read: lane spans and ended jobs. */
export const HISTORY_TYPES: EventType[] = ['job.started', 'job.reattached', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'question.asked'];
