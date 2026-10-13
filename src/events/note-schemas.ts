// Payload schemas of notes to a job (issue #997, design.md "Notes to a running job"), split from schemas.ts for its line
// budget: a note sent, the notes typed into the job's session (how), the notes carried to a new job of its item.
import { z } from 'zod';
import { ACTION_VIAS, NOTE_DELIVERIES } from '../domain/types.ts';

const strict = z.strictObject;
const noteIds = z.array(z.string()).min(1);

export const NOTE_EVENT_SCHEMAS = {
  'job.note_added': strict({ noteId: z.string(), text: z.string(), person: z.string(), via: z.enum(ACTION_VIAS) }),
  'job.note_delivered': strict({ noteIds, delivery: z.enum(NOTE_DELIVERIES) }),
  'job.note_carried': strict({ noteIds, nextJobId: z.string() }),
};
