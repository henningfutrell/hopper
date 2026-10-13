// The memory alert's events (issue #868, design.md "Machine resources over time" → "WSL and the memory alert"): a
// machine's free memory stayed under the threshold, or is back over it. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const freeMemory = { machineId: z.string(), of: z.enum(['windows', 'machine']), freeBytes: z.number(), totalBytes: z.number(), thresholdBytes: z.number() };

export const MACHINE_MEMORY_EVENT_SCHEMAS = {
  'machine.memory_low': z.strictObject({ ...freeMemory, since: z.string() }),
  'machine.memory_recovered': z.strictObject(freeMemory),
} as const;
