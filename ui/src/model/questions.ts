// Which open questions wait on the owner: the nav badge counts them, the Questions view marks them seen.
import type { Question } from './wire.ts';

/** Open, at the human stage, and not yet shown to the owner. */
export const awaitsOwner = (q: Question): boolean => q.status === 'open' && q.tier === 'human' && !q.seenAt;

/** The open questions' one order, the API's too: oldest first, the longest waiting on top, so an arrival lands at the
 *  bottom (issue #450). A gained attempt or a tier change never moves a question. Stable: ties keep the API's order. */
export const longestWaitingFirst = (qs: Question[]): Question[] => [...qs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
