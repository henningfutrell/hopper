// Auto-park in the UI (issues #650, #2335, #2415), pure: whether the answer to a parked job's question picks the job up by
// itself, what a parked job waits on a person for, and whether Pick up is refused for it.
import type { Job, QuestionView, ReviewItemView, ReviewKind } from './wire.ts';

/** Auto-park parked it: the answer to its question picks it up, with no Pick up. */
export const answerPicksUp = (job: Pick<Job, 'parked'>): boolean => job.parked?.auto === true;

/** What a parked job waits on a person for (issue #2415): its open question with a person, or its item at the human stage. */
export type PersonWait = 'question' | ReviewKind;

/** `q`: its open question, if any; `item`: its open proposal or research report, if any (as the engine's `personWaitOf`). */
export function personWait(q: Pick<QuestionView, 'tier'> | undefined, item: Pick<ReviewItemView, 'kind' | 'stage'> | undefined): PersonWait | undefined {
  if (q) return q.tier === 'human' ? 'question' : undefined;
  return item?.stage === 'human' ? item.kind : undefined;
}

/**
 * Pick up is refused (issue #2415): auto-park parked it on a person, and picked up it would only park again at once.
 * The answer to its question, or the decision on its item, picks it up.
 */
export const pickUpRefused = (job: Pick<Job, 'parked' | 'pendingAnswer'>, wait: PersonWait | undefined): boolean =>
  wait !== undefined && job.parked?.auto === true && job.pendingAnswer === undefined;
