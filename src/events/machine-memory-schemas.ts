// The memory alert's events (issue #868, design.md "Machine resources over time" → "WSL and the memory alert"): a
// machine's free memory stayed under the threshold, or is back over it; and the Windows link's (issue #712): Windows does not
// reach the hopper, or reaches it again. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const windowsLink = { machineId: z.string(), url: z.string(), mode: z.string().optional() };
const freeMemory = { machineId: z.string(), of: z.enum(['windows', 'machine']), freeBytes: z.number(), totalBytes: z.number(), thresholdBytes: z.number() };

export const MACHINE_MEMORY_EVENT_SCHEMAS = {
  'machine.memory_low': z.strictObject({ ...freeMemory, since: z.string() }),
  'machine.memory_recovered': z.strictObject(freeMemory),
  // The Windows link (issue #712): src/machines/windows-link-watch.ts.
  'machine.windows_link_broken': z.strictObject({ ...windowsLink, status: z.number().optional(), error: z.string().optional() }),
  'machine.windows_link_restored': z.strictObject(windowsLink),
} as const;
