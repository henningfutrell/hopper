// Payload schemas of a job's trust stamp (issue #655, design.md "Trust stamps"), split from schemas.ts for its line
// budget: a person quarantined a job, or lifted its quarantine; Jev's trust check lowered a job, or a person approved it;
// a person's deny at gate 2 lowered a job, or quarantined it (part 5).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';
import { TRUST_LEVELS } from '../domain/trust-stamp.ts';

const strict = z.strictObject;
const acting = { person: z.string(), via: z.enum(ACTION_VIAS) };

export const TRUST_EVENT_SCHEMAS = {
  'job.quarantined': strict({ was: z.enum(TRUST_LEVELS).optional(), reason: z.string().optional(), ...acting }),
  'job.unquarantined': strict({ level: z.enum(TRUST_LEVELS), ...acting }),
  'job.trust_lowered': z.union([
    strict({ from: z.enum(TRUST_LEVELS), to: z.enum(TRUST_LEVELS), reason: z.string(), by: z.literal('jev') }),
    strict({ from: z.enum(TRUST_LEVELS), to: z.enum(TRUST_LEVELS), reason: z.string(), by: z.literal('person'), ...acting }),
  ]),
  'job.trust_approved': strict({ from: z.enum(TRUST_LEVELS), ...acting }),
};
