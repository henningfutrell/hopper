// One example `data` payload per event type, shaped like the real emitters produce them.
// Used by docs/events.md and by the schema tests.
import type { EventType } from '../domain/types.ts';

const advice = { action: 'proceed_full', reason: 'ok', jevUsed: true, details: { intent: 'x' }, source: 'fake', at: '2026-10-02T00:00:00.000Z' };
const start = { jobId: 'j1', laneId: 'm/lane-1', machineId: 'm', effectivePriority: 50, reason: 'idle lane' };
const lanePlan = { machineId: 'm', current: 0, target: 1, open: 1, close: [], drain: [], reason: 'work waiting' };

export const EVENT_EXAMPLES: Record<EventType, Record<string, unknown>> = {
  'job.queued': { spec: { executor: 'test', payload: { op: 'echo' }, priority: 60, goal: 'g', source: { source: 'github', kind: 'github', key: 'https://x/1', number: 1 } }, priority: 60 },
  'job.prioritized': { advice, mode: 'shadow', statusAtAdvice: 'queued' },
  'job.held': { reason: 'budget' },
  'job.approved': {},
  'job.claimed': { attempts: 1, effectivePriority: 50, reason: 'idle lane' },
  'job.started': { attempts: 1 },
  'job.progressed': { progress: 0.5, message: 'half' },
  'job.finished': { result: { ok: true } },
  'job.failed': { error: 'boom' },
  'job.cancelled': { reason: 'cancelled while queued' },
  'job.requeued': { from: 'waiting_answer', reason: 'answered' },
  'job.reprioritized': { from: 50, to: 80, reason: 'project:Priority=P1' },
  'lane.opened': {},
  'lane.closed': { reason: 'drained' },
  'decision.made': { decisionId: 'd1', trigger: 'tick', jevMode: 'shadow', starts: [start], holds: [{ jobId: 'j2', reason: 'full' }], lanes: [lanePlan], divergences: [{ jobId: 'j1', advice: 'ask_human', native: 'start', withJev: 'hold', note: 'n' }] },
  'jev.mode_changed': { from: 'shadow', to: 'active' },
  'question.asked': { questionId: 'q1', text: 'which?', detectedBy: 'marker' },
  'question.escalated': { questionId: 'q1', target: 'human', reason: 'asked', text: 'which?', jobId: 'j1', goal: 'g', answerUrl: 'http://127.0.0.1/q', notifyCount: 0, renotify: true },
  'question.answered': { questionId: 'q1', by: 'human', answer: 'yes' },
  'question.expired': { questionId: 'q1', after_ms: 1000 },
};
