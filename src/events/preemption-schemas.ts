// Preemption (issue #1525, design.md "Preemption"): a Decision preempted a running job, and an admin changed the setting.
// A memory pause (issue #2291, design.md "The memory floor"): a Decision paused a running job, its machine's memory below the floor.
// A wait release (issue #2303): a Decision ended the agent of a job on its own wait, a job waiting for memory on its machine.
// A completion review setting (issue #2846, design.md "Completion reviews"): an admin changed which ended jobs are reviewed.
// Part of EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';
import { REVIEW_OUTCOMES } from '../domain/completion-review.ts';

const settings = z.strictObject({ enabled: z.boolean(), minRunMinutes: z.number().min(0) });
const reviews = z.strictObject({ on: z.boolean(), outcomes: z.array(z.enum(REVIEW_OUTCOMES)), multiJob: z.boolean(), minRunMinutes: z.number().min(0) });

export const PREEMPTION_EVENT_SCHEMAS = {
  'job.preempted': z.strictObject({ by: z.string(), byPriority: z.number(), priority: z.number(), reason: z.string() }),
  'job.memory_paused': z.strictObject({ availableBytes: z.number().min(0), floorBytes: z.number().positive(), reason: z.string() }),
  'job.wait_released': z.strictObject({ reason: z.string() }),
  'preemption.settings_changed': z.strictObject({ from: settings, to: settings, by: z.string() }),
  'completion_review.settings_changed': z.strictObject({ from: reviews, to: reviews, by: z.string() }),
} as const;

/** Its part of the event reference (docs.ts). */
export const PREEMPTION_EVENT_DOCS = {
  'job.preempted': 'A Decision preempted this running job (issue #1525): job `by`, of priority `byPriority`, waits for a lane, every lane it may use is busy, and this job has the lower priority `priority`. It is parked next (`job.parked`), its lane frees, and it is queued again (`job.unparked`) to resume where it stopped. `reason`: the Decision\'s.',
  'job.memory_paused': 'A Decision paused this running job (issue #2291): its machine has `availableBytes` of memory available, below its memory floor `floorBytes`, and this job has the lowest priority there, of those the one that started there last (issue #2737). Issue #2499: or its machine\'s memory pressure is at or above 40% (`availableBytes` and `floorBytes` its own), or its host pool has `availableBytes` below the pool\'s floor `floorBytes` and this job has the lowest priority on any machine of it. It is parked next (`job.parked`), its lane and memory free, and it is queued again (`job.unparked`) to resume there where it stopped once the memory holds it. `reason`: the Decision\'s.',
  'job.wait_released': 'A Decision ended the agent of this job on its own wait (issues #2303, #2326), on its machine (`machineId`): the hopper ends this wait by itself, with no pane, and a waiting job holds no agent. Its pane and agent end next and its checkpoint is taken; it stays on its wait, its work tree and agent session kept (`waitReleased` on the job). When its wait ends, it resumes its session from that checkpoint on any machine with room, else in a new pane on its machine. `reason`: the Decision\'s.',
  'preemption.settings_changed': 'An admin changed the preemption settings (issue #1525): whether a job of higher priority takes the lane of a running job of lower priority (`enabled`), and how many minutes a job runs before it may be preempted (`minRunMinutes`). `from` and `to`.',
  'completion_review.settings_changed': 'An admin changed which ended jobs get a completion review (issue #2846): on or off (`on`), the ends reviewed (`outcomes`), whether a job of a work item with more than one job is reviewed whatever its end (`multiJob`), and the run time below which a first run is trivial (`minRunMinutes`). `from` and `to`.',
} as const;

/** Its examples (examples.ts). */
export const PREEMPTION_EVENT_EXAMPLES = {
  'job.preempted': { by: 'j-high', byPriority: 75, priority: 50, reason: 'preempts j-low (priority 50, running 42 min) on laptop/lane-2: job j-high of priority 75 waits and every lane it may use is busy' },
  'job.memory_paused': { availableBytes: 1073741824, floorBytes: 1503238554, reason: 'pauses j-new on laptop/lane-6: laptop has 1 GiB available, below its floor of 1.4 GiB; j-new started there last' },
  'job.wait_released': { reason: 'releases the agent of j-wait on laptop: it waits on its own since 42 min ago, and a waiting job holds no agent; it resumes its session when its wait ends, on any machine with room' },
  'preemption.settings_changed': { from: { enabled: true, minRunMinutes: 10 }, to: { enabled: true, minRunMinutes: 20 }, by: 'admin' },
  'completion_review.settings_changed': { from: { on: true, outcomes: ['failed'], multiJob: true, minRunMinutes: 5 }, to: { on: true, outcomes: ['failed', 'cancelled'], multiJob: true, minRunMinutes: 10 }, by: 'admin' },
} as const;
