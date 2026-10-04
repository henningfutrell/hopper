// Which open questions wait on the owner: the nav badge counts them, the Questions view marks them seen.
import type { Question } from './wire.ts';

/** Open, at the human stage, and not yet shown to the owner. */
export const awaitsOwner = (q: Question): boolean => q.status === 'open' && q.tier === 'human' && !q.seenAt;
