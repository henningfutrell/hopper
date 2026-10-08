// One example `data` payload per event type, shaped like the real emitters produce them.
// Used by docs/events.md and by the schema tests.
import type { EventType } from '../domain/types.ts';

const advice = { action: 'proceed_full', reason: 'ok', details: { intent: 'x', gatesAsked: true }, source: 'fake', at: '2026-10-02T00:00:00.000Z' };
const start = { jobId: 'j1', laneId: 'm/lane-1', machineId: 'm', effectivePriority: 50, reason: 'idle lane' };
const lanePlan = { machineId: 'm', current: 0, target: 1, open: 1, close: [], drain: [], reason: 'work waiting' };

export const EVENT_EXAMPLES: Record<EventType, Record<string, unknown>> = {
  'job.queued': { spec: { executor: 'test', payload: { op: 'echo' }, priority: 60, goal: 'g' }, priority: 60, source: { source: 'github', kind: 'github', key: 'https://x/1', number: 1 } },
  'job.prioritized': { advice, statusAtAdvice: 'queued' },
  'job.held': { reason: 'budget' },
  'job.approved': {},
  'job.claimed': { attempts: 1, effectivePriority: 50, reason: 'idle lane' },
  'job.started': { attempts: 1 },
  'job.progressed': { progress: 0.5, message: 'half' },
  'job.finished': { result: { ok: true } },
  'job.failed': { error: 'boom' },
  'job.cancelled': { reason: 'cancelled while queued' },
  'job.requeued': { from: 'waiting_answer', reason: 'answered' },
  'job.reattached': { reason: 'daemon restart' },
  'job.reprioritized': { from: 50, to: 80, reason: 'project:Priority=P1' },
  'lane.opened': {},
  'lane.closed': { reason: 'drained' },
  'decision.made': { decisionId: 'd1', trigger: 'tick', starts: [start], holds: [{ jobId: 'j2', reason: 'full' }], waits: [{ jobId: 'j3', reason: 'waiting for a lane: machine local\'s lane cap is 4, all 4 in use' }], lanes: [lanePlan], divergences: [{ jobId: 'j1', advice: 'ask_human', native: 'start', withAdvice: 'hold', note: 'n' }] },
  'question.asked': { questionId: 'q1', text: 'which?', detectedBy: 'marker' },
  'question.escalated': { questionId: 'q1', target: 'human', reason: 'asked', text: 'which?', jobId: 'j1', goal: 'g', answerUrl: 'http://127.0.0.1/q', notifyCount: 0, renotify: true },
  'question.escalated_to_human': { questionId: 'q1', reason: 'fable: the owner\'s call', text: 'which?', jobId: 'j1', goal: 'g', answerUrl: 'http://127.0.0.1/q', notifyCount: 1 },
  'question.answered': { questionId: 'q1', by: 'human', answer: 'yes' },
  'question.closed': { questionId: 'q1', answer: 'The owner closed this question without answering. Continue on your own judgement; if you cannot, end with HOPPER_FAILED and say why.' },
  'question.dismissed': { questionId: 'q1' },
  'question.expired': { questionId: 'q1', after_ms: 1000 },
  'update.available': { from: 'a1b2c3d', to: 'e4f5a6b', ref: 'main', changes: 3 },
  'update.started': { from: 'a1b2c3d', to: 'e4f5a6b', ref: 'main' },
  'update.applied': { from: 'a1b2c3d', to: 'e4f5a6b', ref: 'main' },
  'update.failed': { to: 'e4f5a6b', error: 'the new build does not load: SyntaxError' },
  'plugin.installed': { id: 'echo-executor', role: 'executor', commit: 'e4f5a6b' },
  'plugin.removed': { id: 'echo-executor' },
  'job.accepted': { by: 'pre-sort' },
  'job.rejected': { by: 'user', reason: 'rejected by the user' },
  'queue.ordered': { jobIds: ['j2', 'j1'] },
  'job.claimed_by_operator': {},
  'job.rerun': { by: 'user' },
  'job.dismissed': { by: 'user' },
  'job.work_kept': { paths: ['/home/me/hopper-jobs/.hopper-scratch/7d0c9b1e-2f4a-4c55-9e3b-1a2b3c4d5e6f/hopper'] },
  'job.unassigned': { assignee: 'octocat' },
  'job.reassigned': { assignee: 'octocat' },
  'source.stalled': { source: 'github-account', kind: 'github-account', error: 'GitHub is down', since: '2026-10-07T20:14:00.000Z' },
  'connected_account.expired': { provider: 'github', account: 'octocat', reason: 'GitHub refused the refresh token (bad_refresh_token)' },
  'queue.gate_changed': { from: { mode: 'auto-accept', autoAcceptPerHour: null }, to: { mode: 'review', autoAcceptPerHour: null } },
};
