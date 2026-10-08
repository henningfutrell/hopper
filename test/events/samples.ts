// Valid samples live with the schemas (docs use them as examples); invalid ones live here.
import type { EventType } from '../../src/domain/types.ts';
import { EVENT_EXAMPLES as VALID_DATA } from '../../src/events/examples.ts';

const advice = { action: 'proceed_full', reason: 'ok', details: {}, source: 'fake', at: '2026-10-02T00:00:00.000Z' };

export { VALID_DATA };

/** A payload that must fail for the type (wrong type of a required field, or a required field missing). */
export const INVALID_DATA: Partial<Record<EventType, Record<string, unknown>>> = {
  'job.queued': { priority: 60 },
  'job.prioritized': { advice, statusAtAdvice: 'sideways' },
  'job.held': {},
  'job.claimed': { attempts: '1' },
  'job.started': {},
  'job.progressed': { progress: 'half' },
  'job.failed': { error: 7 },
  'job.cancelled': {},
  'job.requeued': { from: 'x' },
  'job.reattached': {},
  'job.reprioritized': { from: 50, to: 'high', reason: 'r' },
  'job.respecified': { from: { executor: 'x' }, to: { model: 'm' } },
  'lane.closed': {},
  'decision.made': { decisionId: 'd1' },
  'question.asked': { questionId: 'q1' },
  'question.escalated': { questionId: 'q1', target: 7, reason: 'r', text: 't', jobId: 'j' },
  'question.escalated_to_human': { questionId: 'q1', reason: 'r', text: 't', jobId: 'j', answerUrl: 'u' },
  'question.answered': { questionId: 'q1', by: '', answer: 'a' },
  'question.expired': { questionId: 'q1' },
  'update.available': { from: 'a', to: 'b', ref: 'main' },
  'update.started': { from: 'a' },
  'update.applied': { to: 'b' },
  'update.failed': { error: 3 },
  'job.accepted': { by: 'someone' },
  'job.rejected': { by: 'user' },
  'queue.ordered': { jobIds: 'j1' },
  'job.claimed_by_operator': { by: 'someone' },
  'job.rerun': { by: 'pre-sort' },
  'job.work_kept': { paths: 'p' },
  'job.cleanup_deferred': {},
  'job.cleaned_up': { deferredAt: 3 },
  'queue.gate_changed': { from: { mode: 'open', autoAcceptPerHour: null }, to: { mode: 'review', autoAcceptPerHour: 0 } },
};
