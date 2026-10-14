// Notes to a job (issue #997, design.md "Notes to a running job"): what a person, or an agent over the API, sends a job
// while it works or waits. Kept on the job, in the store, until its session gets it — at the next turn boundary while it
// runs, with its task when it starts, with the answer when it resumes — or a new job of its item carries it. Pure.
import type { ActionVia } from './failures.ts';
import type { JobId, JobStatus } from './types.ts';

/** Where a note is: waiting for the job's session, given to it, or carried to a new job of its item. */
export type JobNoteState = 'queued' | 'delivered' | 'carried';

/** How a note reached the job's session: in its task as it started, at a turn boundary while it ran, or with the answer it resumed with. */
export const NOTE_DELIVERIES = ['start', 'turn', 'resume'] as const;
export type NoteDelivery = typeof NOTE_DELIVERIES[number];

export interface JobNote {
  id: string;
  /** The note as the person wrote it: agent text (Markdown). */
  text: string;
  /** Who sent it: the name the person's session signed in. Never written to GitHub. */
  by: string;
  via: ActionVia;
  /** When it was sent. */
  at: string;
  state: JobNoteState;
  /** Delivered: how, and when. */
  delivery?: NoteDelivery;
  deliveredAt?: string;
  /** Carried: the new job of its item that has it now. */
  carriedTo?: JobId;
  /** On that new job: the job it was sent to. */
  carriedFrom?: JobId;
}

/** The longest note the hopper takes. */
export const MAX_NOTE_CHARS = 4000;

/** The statuses a job takes a note in: every one it may still run from. An ended job takes none, but a failed one may run again. */
const TAKES_NOTES: readonly JobStatus[] = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'waiting_on', 'parked', 'failed'];

/** Why a job takes no note now, or undefined: it does. A failed job takes one only as the newest job of its item. */
export function noteRefusal(status: JobStatus, newestOfItem: boolean): string | undefined {
  if (!TAKES_NOTES.includes(status)) return `the job is ${status}: only a job that may still run takes a note`;
  if (status === 'failed' && !newestOfItem) return 'a newer job of its item exists: send the note to that job';
  return undefined;
}

export const queuedNotes = (notes: readonly JobNote[] | undefined): JobNote[] => (notes ?? []).filter((n) => n.state === 'queued');

/** What the job's session is told: the queued notes, oldest first, between two fixed lines. Names no person. */
export function notesText(notes: readonly Pick<JobNote, 'text'>[]): string {
  const one = notes.length === 1;
  const head = `[hopper] A person sent you ${one ? 'a note' : `${notes.length} notes`} for this job. Read ${one ? 'it' : 'them'}, and use ${one ? 'it' : 'them'} in your work.`;
  const body = one ? notes[0]!.text.trim() : notes.map((n, i) => `Note ${i + 1}:\n${n.text.trim()}`).join('\n\n');
  return `${head}\n\n${body}\n\n[hopper] End of the ${one ? 'note' : 'notes'}. Go on with the job.`;
}
