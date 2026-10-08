// The event types and their payload schema versions (design.md "Events"), apart from types.ts for its size.
// Wire type is the dotted form; the glossary carries the domain name (JobQueued, ...).

export const EVENT_TYPES = [
  'job.queued', 'job.prioritized', 'job.held', 'job.approved', 'job.claimed', 'job.started',
  'job.progressed', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'job.reattached', 'job.reprioritized', 'job.respecified',
  'lane.opened', 'lane.closed', 'decision.made',
  'question.asked', 'question.escalated', 'question.escalated_to_human', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed',
  'update.available', 'update.started', 'update.applied', 'update.failed', 'plugin.installed', 'plugin.removed',
  'job.accepted', 'job.rejected', 'queue.ordered', 'queue.gate_changed', 'job.claimed_by_operator',
  'job.rerun', 'job.dismissed', 'job.unassigned', 'job.reassigned', 'job.work_kept', 'job.work_removed', 'job.cleanup_deferred', 'job.cleaned_up',
  'source.stalled', 'connected_account.expired', 'ui_session.ended', 'source.claim_released', 'source.intake_migrated', 'source.issues_assigned',
  'auth.pending', 'auth.completed', 'auth.expired', 'auth.cancelled', 'auth.failed',
] as const;
export type EventType = typeof EVENT_TYPES[number];

/**
 * Payload schema version per event type (docs/schemas/<type>.v<N>.json). Additive field →
 * same version; removed/renamed/retyped field → bump. The store stamps it on append.
 */
export const EVENT_SCHEMA_VERSIONS: Readonly<Record<EventType, number>> = {
  'job.queued': 1, 'job.prioritized': 3, 'job.held': 1, 'job.approved': 1, 'job.claimed': 1,
  'job.started': 1, 'job.progressed': 1, 'job.finished': 1, 'job.failed': 1, 'job.cancelled': 1,
  'job.requeued': 1, 'job.reattached': 1, 'job.reprioritized': 1, 'job.respecified': 1, 'lane.opened': 1, 'lane.closed': 1,
  'decision.made': 3, 'question.asked': 1, 'question.escalated': 2, 'question.escalated_to_human': 1,
  'question.answered': 2, 'question.closed': 1, 'question.dismissed': 1, 'question.expired': 1, 'question.lapsed': 1,
  'update.available': 1, 'update.started': 1, 'update.applied': 1, 'update.failed': 1, 'plugin.installed': 1, 'plugin.removed': 1,
  'job.accepted': 1, 'job.rejected': 1, 'queue.ordered': 1, 'queue.gate_changed': 1, 'job.claimed_by_operator': 1,
  'job.rerun': 1, 'job.dismissed': 1, 'job.unassigned': 1, 'job.reassigned': 1, 'job.work_kept': 1, 'job.work_removed': 1, 'job.cleanup_deferred': 1, 'job.cleaned_up': 1,
  'source.stalled': 1, 'connected_account.expired': 1, 'ui_session.ended': 1,
  'source.claim_released': 1, 'source.intake_migrated': 1, 'source.issues_assigned': 1,
  'auth.pending': 1, 'auth.completed': 1, 'auth.expired': 1, 'auth.cancelled': 1, 'auth.failed': 1,
};
