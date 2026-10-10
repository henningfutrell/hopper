// Why a question came to a person (issue #679, design.md "Question pipeline"): the reason, the guards that held a sure
// answer back, and what the trail recommended — set when the question reaches the human stage, so the card can say it
// plainly and the Questions list can filter on it.
import type { Escalation, EscalationReason, Question } from '../domain/types.ts';
import { guardHit } from '../minor-decisions/guard.ts';

/** What sends a question to the human stage: the reason, the guards by name, and whether its job may park by itself (issue #650). */
export interface ToHuman { reason: EscalationReason; guards?: string[]; kept?: Question['keptBy'] }

/** Why a question climbs past a level: the text on the trail and events, and the reason a person is told if it was the top one. */
export interface Climb { why: string; reason: EscalationReason }

/** The roles whose answer on the trail is a recommendation to a person. */
const RECOMMENDS = new Set(['level', 'jev', 'fixed']);

/** The escalation for `q` as its trail is now, sent to a person for `to`. */
export function escalationOf(q: Question, to: ToHuman): Escalation {
  const last = q.attempts.findLast((a) => RECOMMENDS.has(a.role) && a.answer !== undefined && a.reason !== 'superseded');
  return {
    reason: to.reason,
    ...(to.guards && to.guards.length > 0 ? { guards: to.guards.map(guardHit) } : {}),
    ...(last ? { recommendation: { by: last.tier, answer: last.answer!, ...(last.confidence ? { confidence: last.confidence } : {}) } } : {}),
  };
}
