// Payload schemas of the lane tuning events (issue #688, design.md "Lane tuning"), split from schemas.ts for its line
// budget: a machine's lane recommendation recorded in shadow, an admin's change to a machine's settings, and in active
// mode a recommendation applied and an admin's undo.
import { z } from 'zod';
import { LANE_TUNING_MODES, LANE_USAGE_BANDS } from '../domain/types.ts';

const strict = z.strictObject;
const lanes = z.number().int().min(0);
// `mode`: additive; absent in a change saved before active mode (shadow).
const laneTuning = strict({ autoTune: z.boolean(), minLanes: lanes, maxLanes: lanes, mode: z.enum(LANE_TUNING_MODES).optional() });

export const LANE_TUNING_EVENT_SCHEMAS = {
  'lanes.recommended': strict({
    machineId: z.string(), lanes, configured: lanes, headroom: lanes.optional(), reason: z.string(),
    confidence: z.number().min(0).max(1), usage: z.enum(LANE_USAGE_BANDS), mode: z.literal('shadow'),
  }),
  'lanes.tuning_changed': strict({ machineId: z.string(), from: laneTuning, to: laneTuning, by: z.string() }),
  'lanes.applied': strict({ machineId: z.string(), from: lanes, to: lanes, configured: lanes, reason: z.string(), confidence: z.number().min(0).max(1) }),
  'lanes.undone': strict({ machineId: z.string(), from: lanes, to: lanes, by: z.string() }),
};
