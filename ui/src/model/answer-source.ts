// Who answered a question or decided a decider pick (issue #1169): a person, or a level or Jev with no person. The one
// line the question form's marker shows. Pure.
import type { MinorDecisionPickView, Question } from './wire.ts';

export interface AnswerSource { kind: 'person' | 'auto'; line: string }

const HUMAN = 'human';

/** A handled question's source; none while nobody answered or closed it. */
export function answerSource(q: Pick<Question, 'status' | 'answeredBy' | 'corrected'>): AnswerSource | undefined {
  if (q.corrected) return { kind: 'person', line: `Corrected by a person; ${q.corrected.level} had answered` };
  if (!q.answeredBy) return undefined;
  if (q.answeredBy === HUMAN) return { kind: 'person', line: `${q.status === 'closed' ? 'Closed' : 'Answered'} by a person` };
  return { kind: 'auto', line: `Auto-decided by ${q.answeredBy}, with no person` };
}

type PickFields = Pick<MinorDecisionPickView, 'options' | 'pick' | 'applied' | 'actual' | 'decidedBy' | 'overridden'>;

/** A decider pick's source: overridden by a person, applied by Jev, or decided later by a person or a level; none while not known. */
export function pickSource(p: PickFields): AnswerSource | undefined {
  const label = (id: string) => p.options.find((o) => o.id === id)?.label ?? id;
  if (p.overridden && p.actual !== undefined) return { kind: 'person', line: `Overridden by a person: ${label(p.actual)}` };
  if (p.actual !== undefined && p.decidedBy) {
    return p.decidedBy === HUMAN
      ? { kind: 'person', line: `Decided by a person: ${label(p.actual)}` }
      : { kind: 'auto', line: `Auto-decided by ${p.decidedBy}: ${label(p.actual)}` };
  }
  if (p.applied && p.pick !== undefined) return { kind: 'auto', line: `Auto-decided by Jev: ${label(p.pick)}` };
  return undefined;
}
