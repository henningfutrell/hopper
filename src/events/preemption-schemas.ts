// Preemption (issue #1525, design.md "Preemption"): a Decision preempted a running job, and an admin changed the setting.
// Part of EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';

const settings = z.strictObject({ enabled: z.boolean(), minRunMinutes: z.number().min(0) });

export const PREEMPTION_EVENT_SCHEMAS = {
  'job.preempted': z.strictObject({ by: z.string(), byPriority: z.number(), priority: z.number(), reason: z.string() }),
  'preemption.settings_changed': z.strictObject({ from: settings, to: settings, by: z.string() }),
} as const;

/** Its part of the event reference (docs.ts). */
export const PREEMPTION_EVENT_DOCS = {
  'job.preempted': 'A Decision preempted this running job (issue #1525): job `by`, of priority `byPriority`, waits for a lane, every lane it may use is busy, and this job has the lower priority `priority`. It is parked next (`job.parked`), its lane frees, and it is queued again (`job.unparked`) to resume where it stopped. `reason`: the Decision\'s.',
  'preemption.settings_changed': 'An admin changed the preemption settings (issue #1525): whether a job of higher priority takes the lane of a running job of lower priority (`enabled`), and how many minutes a job runs before it may be preempted (`minRunMinutes`). `from` and `to`.',
} as const;

/** Its examples (examples.ts). */
export const PREEMPTION_EVENT_EXAMPLES = {
  'job.preempted': { by: 'j-high', byPriority: 75, priority: 50, reason: 'preempts j-low (priority 50, running 42 min) on laptop/lane-2: job j-high of priority 75 waits and every lane it may use is busy' },
  'preemption.settings_changed': { from: { enabled: true, minRunMinutes: 10 }, to: { enabled: true, minRunMinutes: 20 }, by: 'admin' },
} as const;
