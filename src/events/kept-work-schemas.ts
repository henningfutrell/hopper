// Work not pushed's events beyond the work trail (issue #1194, design.md "Work not pushed"): a person's discard, answered
// before the removal on the job's machine, failed there after. Part of EVENT_SCHEMAS (schemas.ts), with their docs (docs.ts)
// and examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

export const KEPT_WORK_EVENT_SCHEMAS = {
  // Who, and the way, when a person discarded it.
  'job.work_discard_failed': z.strictObject({ error: z.string(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() }),
} as const;

/** Their part of the event reference (docs.ts). */
export const KEPT_WORK_EVENT_DOCS = {
  'job.work_discard_failed': 'A person discarded the kept work in Failures, Work not pushed (issue #1010), and the removal on the job\'s machine, which runs after the answer (issue #1194), failed: `error` says why (its machine out of reach, or a client older than the discard that kept it). The work is still kept, and Discard is offered again. `person` and `via` say who and the way.',
} as const;

/** Their examples (examples.ts). */
export const KEPT_WORK_EVENT_EXAMPLES = {
  'job.work_discard_failed': { error: 'job 7d0c9b1e\'s work cannot be discarded: its machine desk is out of reach', person: 'Pat', via: 'ui' },
} as const;
