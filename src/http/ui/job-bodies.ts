// The bodies of the job and question actions of the UI session.
import { z } from 'zod';

export const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
/** Reject's optional reason (issue #387): kept on the job and in its timeline, never written to the issue. */
export const rejectBody = z.object({ reason: z.string().trim().max(500, 'reason must be at most 500 characters').optional() });
/** Re-queue's confirmation (issue #530): `freshSession` true agrees that a parked job with no agent session starts a fresh one. */
export const requeueBody = z.object({ freshSession: z.boolean().optional() }).strict();
/** Assign to me, or release a claim, on items a job source listed (issue #440). */
export const intakeActionBody = z.object({
  kind: z.enum(['assign', 'release']),
  keys: z.array(z.string().min(1)).min(1, 'name at least one item').max(100, 'at most 100 items at once'),
}).strict();
export const sourceParams = z.object({ name: z.string().min(1) });
