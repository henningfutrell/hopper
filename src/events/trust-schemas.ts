// Payload schemas of a job's trust stamp (issue #655, design.md "Trust stamps"), split from schemas.ts for its line
// budget: a person quarantined a job, or lifted its quarantine; Jev's trust check lowered a job, or a person approved it;
// a person's or Jev's deny at gate 2 lowered a job, or quarantined it (parts 5, 13); the store signed a stamp from where a job came (part 11).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';
import { STAMPED_BY, TRUST_LEVELS } from '../domain/trust-stamp.ts';

const strict = z.strictObject;
const acting = { person: z.string(), via: z.enum(ACTION_VIAS) };

export const TRUST_EVENT_SCHEMAS = {
  // `person` and `via`, or `by` `jev` when Jev's second deny at gate 2 quarantined it (part 13).
  'job.quarantined': strict({ was: z.enum(TRUST_LEVELS).optional(), reason: z.string().optional(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional(), by: z.enum(['jev']).optional() }),
  'job.unquarantined': strict({ level: z.enum(TRUST_LEVELS), ...acting }),
  // `person` and `via` only when `by` is `person` (part 5: a person's deny at gate 2).
  'job.trust_lowered': strict({ from: z.enum(TRUST_LEVELS), to: z.enum(TRUST_LEVELS), reason: z.string(), by: z.enum(['jev', 'person', 'edit']), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() }),
  'job.trust_approved': strict({ from: z.enum(TRUST_LEVELS), ...acting }),
  // Part 11: a stamp the store signed from where the job came. `from` only when it had a stamp that verified; never the MAC.
  'intake.stamped': strict({ level: z.enum(TRUST_LEVELS), reasons: z.array(z.string()), by: z.enum(STAMPED_BY), was: z.enum(TRUST_LEVELS).optional(), from: z.enum(TRUST_LEVELS).optional(), spec: z.string().regex(/^[0-9a-f]{64}$/) }),
};
