// A person's Run again or Rework, answered before its source gives the item back (issue #1194, design.md "Actions answer
// at once"): the give-back failed after the answer. Part of EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and
// examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

export const GIVE_BACK_EVENT_SCHEMAS = {
  'job.give_back_failed': z.strictObject({ act: z.enum(['rerun', 'rework']), error: z.string(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() }),
} as const;

/** Its part of the event reference (docs.ts). */
export const GIVE_BACK_EVENT_DOCS = {
  'job.give_back_failed': 'A person\'s Run again (`act` `rerun`) or Rework (`rework`) of this ended job was answered at once, and its source\'s give-back, which runs after the answer (issue #1194) — on GitHub the issue reopened, assigned and its end labels gone, for Rework the pull request made a draft first —, failed: `error` says why (GitHub out of reach or refusing, the issue no longer assigned to the connected account, a newer job of its item made meanwhile). No new job was made, and the act is offered again. `person` and `via` say who and the way.',
} as const;

/** Its examples (examples.ts). */
export const GIVE_BACK_EVENT_EXAMPLES = {
  'job.give_back_failed': { act: 'rerun', error: 'its source could not give the item back: GitHub answered 502', person: 'Pat', via: 'ui' },
} as const;
