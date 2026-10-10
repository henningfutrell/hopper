// Payload schemas of the lane tuning events (issue #688, design.md "Lane tuning"), split from schemas.ts for its line
// budget: a machine's lane recommendation recorded in shadow, and an admin's change to a machine's settings.
import { z } from 'zod';
import { LANE_USAGE_BANDS } from '../domain/types.ts';

const strict = z.strictObject;
const lanes = z.number().int().min(0);
const laneTuning = strict({ autoTune: z.boolean(), minLanes: lanes, maxLanes: lanes });

export const LANE_TUNING_EVENT_SCHEMAS = {
  'lanes.recommended': strict({
    machineId: z.string(), lanes, configured: lanes, headroom: lanes.optional(), reason: z.string(),
    confidence: z.number().min(0).max(1), usage: z.enum(LANE_USAGE_BANDS), mode: z.literal('shadow'),
  }),
  'lanes.tuning_changed': strict({ machineId: z.string(), from: laneTuning, to: laneTuning, by: z.string() }),
};
