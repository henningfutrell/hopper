// The event loop watchdog's event (issue #1154, design.md "What holds the event loop"): the hopper's one event loop was
// held, and for how long; the routes in flight and the slow store calls in it. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

export const EVENT_LOOP_EVENT_SCHEMAS = {
  'hopper.event_loop_stalled': z.strictObject({
    ms: z.number().int(),
    during: z.array(z.string()),
    store: z.strictObject({ ms: z.number().int(), calls: z.array(z.strictObject({ what: z.string(), ms: z.number().int(), count: z.number().int() })) }).optional(),
    skipped: z.number().int(),
  }),
} as const;
