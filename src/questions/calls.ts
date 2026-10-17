// A level's call on a question and where a restart goes on (issue #1608, design.md "Question pipeline"): the call is
// recorded as a `started` attempt with its call key before the model is asked, so a call the daemon stopped during
// leaves a record; recovery goes on at the stored level, so no level below it is called again.
import type { EscalationLevel, UserStore } from '../domain/ports.ts';
import type { Climb } from './escalation.ts';

/** Inside a tx. The level's call, recorded before the model is asked: a `started` attempt whose key its reply is kept under. */
export function startCall(store: UserStore, id: string, level: EscalationLevel, startedAt: string): string {
  const q = store.questions.get(id)!;
  const callKey = `${id}:${q.attempts.length + 1}`;
  store.questions.addAttempt(id, { tier: level.name, role: 'level', ...(level.model ? { model: level.model } : {}), startedAt, outcome: 'started', callKey });
  return callKey;
}

/**
 * Inside a tx. Where a question a restart left open goes on: at its stored level, so no level below it is asked again;
 * past that level when its reply is kept already; from the first only when no level has that name now. A call the daemon
 * stopped during is marked interrupted at `at`, and its level is asked again.
 */
export function resumeAt(store: UserStore, at: string, id: string, levels: readonly EscalationLevel[], climb: Climb): { from: number; climb: Climb } {
  const q = store.questions.get(id);
  if (!q) return { from: 0, climb };
  for (const a of q.attempts) {
    if (a.outcome === 'started' && a.callKey) store.questions.finishAttempt(id, a.callKey, { ...a, finishedAt: at, outcome: 'interrupted', reason: 'the daemon stopped during the call: asked again' });
  }
  const i = levels.findIndex((l) => l.name === q.tier);
  if (i < 0) return { from: 0, climb };
  const last = q.attempts.at(-1);
  if (last?.role !== 'level' || last.tier !== q.tier || last.outcome !== 'escalated') return { from: i, climb };
  return { from: i + 1, climb: { why: `${q.tier}: ${last.error ? `failed: ${last.error}` : (last.reason ?? 'escalated')}`, reason: last.escalate ? 'frontier_escalated' : 'no_answer' } };
}
