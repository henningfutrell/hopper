// The memory alert's events (issue #868, design.md "Machine resources over time" → "WSL and the memory alert"): a
// machine's free memory stayed under the threshold, or is back over it; and the Windows link's (issue #712): Windows does not
// reach the hopper, or reaches it again; and the offline watch's (issue #1497): a machine stayed offline, or is online again;
// and the allocation failure watch's (issue #2622 part 6): a burst of large page allocation failures, and its end.
// Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const windowsLink = { machineId: z.string(), url: z.string(), mode: z.string().optional() };
const offline = { machineId: z.string(), label: z.string(), since: z.string() };
const freeMemory = { machineId: z.string(), of: z.enum(['windows', 'machine']), freeBytes: z.number(), totalBytes: z.number(), thresholdBytes: z.number() };

export const MACHINE_MEMORY_EVENT_SCHEMAS = {
  'machine.memory_low': z.strictObject({ ...freeMemory, since: z.string() }),
  'machine.memory_recovered': z.strictObject(freeMemory),
  // The Windows link (issue #712): src/machines/windows-link-watch.ts.
  'machine.windows_link_broken': z.strictObject({ ...windowsLink, status: z.number().optional(), error: z.string().optional() }),
  'machine.windows_link_restored': z.strictObject(windowsLink),
  // The offline watch (issue #1497): src/machines/offline-watch.ts.
  'machine.offline': z.strictObject(offline),
  'machine.back_online': z.strictObject(offline),
  // The allocation failure watch (issue #2622 part 6): src/machines/alloc-failure-watch.ts.
  'machine.allocation_failures': z.strictObject({ ...offline, count: z.number(), maxOrder: z.number() }),
  'machine.allocation_failures_ended': z.strictObject(offline),
} as const;
