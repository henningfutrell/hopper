// The bodies of the job and question actions of the UI session.
import { z } from 'zod';
import { DECLINE_CHOICES } from '../../domain/intake-decline.ts';
import { MAX_REWORK_NOTES } from '../../domain/pull-requests.ts';
import { MAX_NOTE_CHARS } from '../../domain/job-notes.ts';
import { PARK_REASON_MAX } from '../../domain/park-ask.ts';

export const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
/** Cancel's optional reason (issue #1460): a person's own words why, kept on job.cancelled as its note, never written to the issue. */
export const cancelBody = z.object({ reason: z.string().trim().max(500, 'reason must be at most 500 characters').optional() }).strict();
/** The critical flag (issue #2203): set or cleared. */
export const criticalBody = z.object({ critical: z.boolean() }).strict();
/** Park's optional reason (issue #2167): kept on the parked job and on job.parked, never written to the issue. */
export const parkBody = z.object({ reason: z.string().trim().max(PARK_REASON_MAX, `reason must be at most ${PARK_REASON_MAX} characters`).optional() }).strict();
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
/** Dismiss many (issue #1123): the failed jobs named, or (`superseded`) every one nothing waits on any more. One of the two. */
export const MAX_DISMISS = 1000;
export const dismissManyBody = z.object({
  jobIds: z.array(z.string().min(1)).min(1, 'jobIds must name a job').max(MAX_DISMISS, `jobIds must name at most ${MAX_DISMISS} jobs`).optional(),
  superseded: z.literal(true).optional(),
}).strict().refine((b) => (b.jobIds === undefined) !== (b.superseded === undefined), 'send jobIds or superseded: true, one of the two');
/** A note to a job (issue #997): typed into its session at the next turn boundary, or kept until it resumes. Required. */
export const noteBody = z.object({
  text: z.string().trim().min(1, 'text must not be empty').max(MAX_NOTE_CHARS, `text must be at most ${MAX_NOTE_CHARS} characters`),
}).strict();
/**
 * Assign to me, or release a claim, on items a job source listed (issue #440); approve a request card (issue #652): one
 * item, with the hash of its title and body as the person read them; take items off the backburner (issue #798).
 */
/** The intake actions on a request card's text (issues #652, #1035): one item, with the hash of the text as read. */
const hashed = (kind: string): boolean => kind === 'approve' || kind === 'decline';
export const intakeActionBody = z.object({
  kind: z.enum(['assign', 'release', 'approve', 'unbackburner', 'decline', 'dismiss', 'take_in', 'retry_outbox', 'wont_do']),
  keys: z.array(z.string().min(1)).min(1, 'name at least one item').max(100, 'at most 100 items at once'),
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256, hex').optional(),
  /** `decline` (issue #1710): close the issue or leave it open; absent, the user's default. */
  choice: z.enum(DECLINE_CHOICES).optional(),
}).strict()
  .refine((b) => !hashed(b.kind) || (b.keys.length === 1 && b.hash !== undefined), { message: 'approve and decline name one item and its hash' })
  .refine((b) => hashed(b.kind) || b.hash === undefined, { message: 'only approve and decline take a hash' })
  .refine((b) => b.kind === 'decline' || b.choice === undefined, { message: 'only decline takes a choice' });
export const sourceParams = z.object({ name: z.string().min(1) });
