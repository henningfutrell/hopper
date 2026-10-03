// Valid samples live with the schemas (docs use them as examples); invalid ones live here.
import type { EventType } from '../../src/domain/types.ts';
import { EVENT_EXAMPLES as VALID_DATA } from '../../src/events/examples.ts';

const advice = { action: 'proceed_full', reason: 'ok', jevUsed: true, details: {}, source: 'fake', at: '2026-10-02T00:00:00.000Z' };

export { VALID_DATA };

/** A payload that must fail for the type (wrong type of a required field, or a required field missing). */
export const INVALID_DATA: Partial<Record<EventType, Record<string, unknown>>> = {
  'job.queued': { priority: 60 },
  'job.prioritized': { advice, mode: 'sideways', statusAtAdvice: 'queued' },
  'job.held': {},
  'job.claimed': { attempts: '1' },
  'job.started': {},
  'job.progressed': { progress: 'half' },
  'job.failed': { error: 7 },
  'job.cancelled': {},
  'job.requeued': { from: 'x' },
  'job.reprioritized': { from: 50, to: 'high', reason: 'r' },
  'lane.closed': {},
  'decision.made': { decisionId: 'd1' },
  'jev.mode_changed': { from: 'shadow', to: 'loud' },
  'question.asked': { questionId: 'q1' },
  'question.escalated': { questionId: 'q1', target: 'nobody', reason: 'r', text: 't', jobId: 'j' },
  'question.answered': { questionId: 'q1', by: 'robot', answer: 'a' },
  'question.expired': { questionId: 'q1' },
};
