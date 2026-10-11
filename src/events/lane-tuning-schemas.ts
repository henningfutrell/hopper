// Payload schemas of the lane tuning events (issue #688, design.md "Lane tuning"), split from schemas.ts for its line
// budget: a machine's lane recommendation recorded, an admin's change to a machine's settings, and an admin's apply,
// undo and dismissal of a recommendation.
import { z } from 'zod';
import { LANE_USAGE_BANDS } from '../domain/types.ts';

const strict = z.strictObject;
const lanes = z.number().int().min(0);
const confidence = z.number().min(0).max(1);
// `mode`: only in the events recorded while lane tuning had a shadow and an active mode, before it applied nothing by itself.
const mode = z.enum(['shadow', 'active']).optional();
const laneTuning = strict({ autoTune: z.boolean(), minLanes: lanes, maxLanes: lanes, mode });

export const LANE_TUNING_EVENT_SCHEMAS = {
  'lanes.recommended': strict({
    machineId: z.string(), lanes, configured: lanes, headroom: lanes.optional(), reason: z.string(),
    confidence, usage: z.enum(LANE_USAGE_BANDS), mode: z.literal('shadow').optional(),
  }),
  'lanes.tuning_changed': strict({ machineId: z.string(), from: laneTuning, to: laneTuning, by: z.string() }),
  // `by`: the admin who applied it. Absent, with `configured`: the hopper applied it itself in active mode.
  'lanes.applied': strict({ machineId: z.string(), from: lanes, to: lanes, configured: lanes.optional(), reason: z.string(), confidence, by: z.string().optional() }),
  'lanes.undone': strict({ machineId: z.string(), from: lanes, to: lanes, by: z.string() }),
  'lanes.dismissed': strict({ machineId: z.string(), lanes, configured: lanes, reason: z.string(), by: z.string() }),
};
