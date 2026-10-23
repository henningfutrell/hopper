// Drained machines' events (issue #1511, design.md "Draining a machine"): a person drained a machine, or undrained it.
// Issue #2499: a drain names why and when it ends; it ended by itself; a drained machine sat idle with a backlog.
// Part of EVENT_SCHEMAS (schemas.ts), with their docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

const drain = { machineId: z.string(), person: z.string(), via: z.enum(ACTION_VIAS) };

export const MACHINE_DRAIN_EVENT_SCHEMAS = {
  // `reason` and `until` are absent on drains recorded before issue #2499.
  'machine.drained': z.strictObject({ ...drain, reason: z.string().optional(), until: z.string().optional() }),
  'machine.undrained': z.strictObject(drain),
  'machine.drain_expired': z.strictObject({ ...drain, at: z.string(), until: z.string(), reason: z.string().optional() }),
  'machine.drained_idle': z.strictObject({
    machineId: z.string(), label: z.string(), since: z.string(), drainedAt: z.string(), until: z.string(), reason: z.string().optional(),
    freeLanes: z.number().int(), queued: z.number().int(),
  }),
} as const;

/** Their part of the event reference (docs.ts). */
export const MACHINE_DRAIN_EVENT_DOCS = {
  'machine.drained': 'A person drained `machineId` (issue #1511): from now on no new job is placed on it, and the jobs on it run to their end. A job resuming there returns to its pane. Kept across restarts until a person undrains it, or until `until`, when it ends by itself (`machine.drain_expired`, issue #2499). `person` and `via` say who and the way; `reason` why (issue #2499).',
  'machine.undrained': 'A person undrained `machineId` (issue #1511): new jobs are placed on it again. `person` and `via` say who and the way.',
  'machine.drain_expired': 'The drain of `machineId` reached its end, `until`, and ended by itself (issue #2499): new jobs are placed on it again. `person` and `via` say who drained it and the way, `at` when, `reason` why. A drain recorded before drains had an end ends a day after `at`.',
  'machine.drained_idle': 'A drained machine stayed online with `freeLanes` free lanes, while `queued` jobs it could run waited, from `since` for ten minutes (issue #2499): told once, so a person can undrain it. Told again after the backlog clears, the machine is undrained, offline or full, and it is idle with a backlog again. `drainedAt`, `until` and `reason` are its drain\'s.',
} as const;

/** Their examples (examples.ts). */
export const MACHINE_DRAIN_EVENT_EXAMPLES = {
  'machine.drained': { machineId: 'desk', person: 'Pat', via: 'cli', reason: 'seat rebuild', until: '2026-10-23T09:00:00.000Z' },
  'machine.undrained': { machineId: 'desk', person: 'Pat', via: 'ui' },
  'machine.drain_expired': { machineId: 'desk', person: 'Pat', via: 'cli', at: '2026-10-22T09:00:00.000Z', until: '2026-10-23T09:00:00.000Z', reason: 'seat rebuild' },
  'machine.drained_idle': { machineId: 'desk', label: 'desk', since: '2026-10-22T10:00:00.000Z', drainedAt: '2026-10-22T09:00:00.000Z', until: '2026-10-23T09:00:00.000Z', reason: 'seat rebuild', freeLanes: 2, queued: 31 },
} as const;
