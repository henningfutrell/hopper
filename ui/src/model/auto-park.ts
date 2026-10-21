// Auto-park in the UI (issues #650, #2335), pure: whether the answer to a parked job's question picks the job up by itself.
import type { Job } from './wire.ts';

/** Auto-park parked it: the answer to its question picks it up, with no Pick up. */
export const answerPicksUp = (job: Pick<Job, 'parked'>): boolean => job.parked?.auto === true;
