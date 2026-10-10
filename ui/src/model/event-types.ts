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
  'job.parked': true, 'job.unparked': true, 'job.continued': true,
  'source.stalled': true, 'connected_account.expired': true, 'connected_account.renewed': true, 'connected_account.renewal_failed': true, 'ui_session.ended': true,
  'source.claim_released': true, 'source.intake_migrated': true, 'source.issues_assigned': true,
  'auth.pending': true, 'auth.completed': true, 'auth.expired': true, 'auth.cancelled': true, 'auth.failed': true,
  'job.assessed': true, 'failure.grouped': true, 'failure.resolved': true, 'failure.released': true, 'handoff.opened': true, 'handoff.closed': true, 'handoff.checked': true,
  'usage.limits_changed': true, 'priority_lanes.changed': true, 'priority_lanes.settings_changed': true,
  'proposal.asked': true, 'proposal.submitted': true, 'proposal.escalated': true, 'proposal.escalated_to_human': true, 'proposal.reviewed': true,
  'proposal.revision_requested': true, 'proposal.accepted': true, 'proposal.rejected': true, 'proposal.cancelled': true,
  'research.asked': true, 'research.submitted': true, 'research.escalated': true, 'research.escalated_to_human': true, 'research.reviewed': true,
  'research.revision_requested': true, 'research.accepted': true, 'research.cancelled': true,
  'machine.discovered': true, 'machine.discovery_failed': true, 'machine.radius_grew': true, 'machine.actor_mismatch': true, 'blast_radius.settings_changed': true, 'job.gate_passed': true,
  'minor_decision.picked': true, 'minor_decision.compared': true, 'minor_decision.overridden': true, 'minor_decision.settings_changed': true,
  'job.phase_changed': true, 'job.forked': true, 'job.fork_resolved': true, 'phase_shifts.settings_changed': true,
  'question.corrected': true, 'auto_answer.settings_changed': true,
  'github_proxy.done': true, 'github_proxy.refused': true, 'github_proxy.failed': true,
  'vault.secret_set': true, 'vault.secret_removed': true, 'template.saved': true, 'template.removed': true, 'vault.approved': true, 'vault.revoked': true, 'template.profile_approved': true, 'vault.delivered': true, 'vault.refused': true, 'vault.minted': true, 'vault.mint_refused': true,
  'vault.credential_asked': true, 'vault.credential_given': true, 'vault.credential_declined': true,
  'yolo_mode.changed': true, 'job.pull_request_merged': true, 'job.pull_request_closed': true, 'job.finish_briefed': true,
  'skill.listed': true, 'skill.loaded': true, 'skill.refused': true,
  'artifact.created': true, 'artifact.shared': true, 'artifact.share_revoked': true, 'artifact.removed': true, 'artifact.settings_changed': true,
};
export const EVENT_TYPES = Object.keys(ALL) as EventType[];

/** The types the lane spans and question waits read (the lane timeline, the Running card); an operator-led claim starts a span too. */
export const HISTORY_TYPES: EventType[] = [
  'job.started', 'job.reattached', 'job.claimed_by_operator', 'job.finished', 'job.failed', 'job.cancelled', 'job.requeued', 'job.parked',
  'question.asked', 'question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed',
];
