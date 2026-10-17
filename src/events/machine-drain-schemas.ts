// Drained machines' events (issue #1511, design.md "Draining a machine"): a person drained a machine, or undrained it.
// Part of EVENT_SCHEMAS (schemas.ts), with their docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

const drain = { machineId: z.string(), person: z.string(), via: z.enum(ACTION_VIAS) };

export const MACHINE_DRAIN_EVENT_SCHEMAS = {
  'machine.drained': z.strictObject(drain),
  'machine.undrained': z.strictObject(drain),
} as const;

/** Their part of the event reference (docs.ts). */
export const MACHINE_DRAIN_EVENT_DOCS = {
  'machine.drained': 'A person drained `machineId` (issue #1511): from now on no new job is placed on it, and the jobs on it run to their end. A job resuming there returns to its pane. Kept across restarts until a person undrains it. `person` and `via` say who and the way.',
  'machine.undrained': 'A person undrained `machineId` (issue #1511): new jobs are placed on it again. `person` and `via` say who and the way.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DRAIN_EVENT_EXAMPLES = {
  'machine.drained': { machineId: 'desk', person: 'Pat', via: 'cli' },
  'machine.undrained': { machineId: 'desk', person: 'Pat', via: 'ui' },
} as const;
