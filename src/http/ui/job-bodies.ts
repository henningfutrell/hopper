// The bodies of the job and question actions of the UI session.
import { z } from 'zod';
import { MAX_REWORK_NOTES } from '../../domain/pull-requests.ts';

export const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
/** Reject's optional reason (issue #387): kept on the job and in its timeline, never written to the issue. */
export const rejectBody = z.object({ reason: z.string().trim().max(500, 'reason must be at most 500 characters').optional() });
/** Rework's notes (issue #724): what the new job is told to change in the pull request sent back. Required. */
export const reworkBody = z.object({
  notes: z.string().trim().min(1, 'notes must not be empty').max(MAX_REWORK_NOTES, `notes must be at most ${MAX_REWORK_NOTES} characters`),
}).strict();
/**
 * Re-queue's confirmation (issue #530): `freshSession` true agrees that a parked job with no agent session starts a fresh
 * one. `elsewhere` (issue #921): it resumes on any machine from its checkpoint, not pinned to its own.
 */
export const requeueBody = z.object({ freshSession: z.boolean().optional(), elsewhere: z.boolean().optional() }).strict();
/** Ending a job's own wait (issue #483): the person's optional note, typed into its pane with it. */
export const endWaitBody = z.object({ note: z.string().trim().max(2000, 'note must be at most 2000 characters').optional() }).strict();
/**
 * Assign to me, or release a claim, on items a job source listed (issue #440); approve a request card (issue #652): one
 * item, with the hash of its title and body as the person read them; take items off the backburner (issue #798).
 */
export const intakeActionBody = z.object({
  kind: z.enum(['assign', 'release', 'approve', 'unbackburner']),
  keys: z.array(z.string().min(1)).min(1, 'name at least one item').max(100, 'at most 100 items at once'),
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256, hex').optional(),
}).strict()
  .refine((b) => b.kind !== 'approve' || (b.keys.length === 1 && b.hash !== undefined), { message: 'approve names one item and its hash' })
  .refine((b) => b.kind === 'approve' || b.hash === undefined, { message: 'only approve takes a hash' });
export const sourceParams = z.object({ name: z.string().min(1) });
