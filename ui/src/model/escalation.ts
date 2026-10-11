// Why a question came to a person (issue #679): one plain sentence for the top of its card — every hold on the answer —,
// what the levels recommend, and the reasons the Questions list filters by.
import type { Escalation, EscalationHold, EscalationReason, Question } from './wire.ts';

/** Each reason as the filter names it. */
export const REASON_LABELS: Record<EscalationReason, string> = {
  guard: 'Guard', low_confidence: 'Not confident', no_answer: 'No answer', frontier_escalated: 'Sent up',
  high_priority: 'High priority', auto_answer_off: 'Auto-answer off', fork: 'Fork',
};

/** A level, Jev or the fixed answers, as a person reads its name: `fable` → `Fable`. */
export const stageName = (tier: string): string => tier.charAt(0).toUpperCase() + tier.slice(1);

/** One hold as part of the sentence: `risk rule credentials holds it`, `Fable was not confident enough (medium confidence, needs high)`. */
function holdPhrase(h: EscalationHold, by: string | undefined): string {
  const names = (h.guards ?? []).map((g) => g.name);
  const plural = names.length === 1 ? '' : 's';
  switch (h.reason) {
    case 'guard': return `${h.by === 'risk' ? `risk rule${plural}` : `guard${plural}`} ${names.join(', ')} ${names.length === 1 ? 'holds' : 'hold'} it`;
    case 'high_priority': return 'its job is high priority';
    case 'auto_answer_off': return 'auto-answer is off';
    case 'low_confidence': return `${by ?? 'the level'} was not confident enough (${h.confidence ?? 'no'} confidence, needs ${h.threshold ?? 'more'})`;
  }
}

/** `a`, `a and b`, `a, b and c`. */
const andList = (xs: string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Every hold, in one sentence; a guard says the answer was held back on purpose. */
function holdsSentence(e: Escalation, holds: EscalationHold[], by: string | undefined): string {
  const said = `Sent to you because ${andList(holds.map((h) => holdPhrase(h, by)))}.`;
  if (!holds.some((h) => h.reason === 'guard')) return said;
  const confidence = e.recommendation?.confidence;
  return `${said} ${by ? `${by}'s ${confidence ? `${confidence}-confidence ` : ''}answer is` : 'Any answer is'} held back on purpose; a person decides.`;
}

/** Why the question came to a person, in one sentence: every hold, when it has them. Absent: sent before the reason was recorded. */
export function reasonSentence(e: Escalation | undefined): string {
  const by = e?.recommendation ? stageName(e.recommendation.by) : undefined;
  if (e?.holds && e.holds.length > 0) return holdsSentence(e, e.holds, by);
  switch (e?.reason) {
    case 'guard': {
      const guards = (e.guards ?? []).map((g) => `${g.name} (${g.describe})`).join(', ');
      const confidence = e.recommendation?.confidence;
      const held = by ? `${by}'s ${confidence ? `${confidence}-confidence ` : ''}answer is` : 'Any answer is';
      return `Sent to you because a guard holds it: ${guards || 'a guard rule'}. ${held} held back on purpose; a person decides.`;
    }
    case 'low_confidence': {
      const confidence = e.recommendation?.confidence;
      return `Sent to you because ${by ?? 'the top level'} was not confident enough${confidence ? ` (${confidence} confidence)` : ''}.`;
    }
    case 'no_answer': return 'Sent to you because no level gave an answer.';
    case 'frontier_escalated': return `Sent to you because ${by ?? 'the top level'} sent it up to a person.`;
    case 'high_priority': return 'Sent to you because its job is high priority: a person answers.';
    case 'auto_answer_off': return 'Sent to you because auto-answer is off: the levels only recommend.';
    case 'fork': return 'Sent to you while a fork works on it: answer now, or wait for its result.';
    case undefined: return 'Sent to you. The reason was not recorded for this question.';
  }
}

/** The longest recommendation the banner shows; the full answer is on the trail. */
const RECOMMENDATION_CHARS = 200;

/** What the level recommends, in one line: `Fable says: go ahead`; none when no level gave an answer. */
export function recommendationLine(e: Escalation | undefined): string | undefined {
  const r = e?.recommendation;
  if (!r) return undefined;
  const first = r.answer.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const text = first.length > RECOMMENDATION_CHARS ? `${first.slice(0, RECOMMENDATION_CHARS - 1)}…` : first;
  return `${stageName(r.by)} says: ${text}${r.confidence ? ` (${r.confidence} confidence)` : ''}`;
}

/** Every reason the question came to a person for: the strongest, and each hold's (issue #679). */
export function reasonsOf(e: Escalation | undefined): EscalationReason[] {
  return e ? [...new Set([e.reason, ...(e.holds ?? []).map((h) => h.reason)])] : [];
}

/** The reasons present among the questions at the human stage, in label order, with how many have each; a question counts under each of its reasons. */
export function reasonCounts(qs: readonly Question[]): { reason: EscalationReason; count: number }[] {
  const counts = new Map<EscalationReason, number>();
  for (const q of qs) if (q.tier === 'human') for (const r of reasonsOf(q.escalation)) counts.set(r, (counts.get(r) ?? 0) + 1);
  return (Object.keys(REASON_LABELS) as EscalationReason[]).filter((r) => counts.has(r)).map((reason) => ({ reason, count: counts.get(reason)! }));
}

/** An attempt reason as stored before issue #679 may end in " (no rules yet)"; the trail shows it without. */
export const trailReason = (reason: string): string => reason.replace(/ \(no rules yet\)$/, '');
