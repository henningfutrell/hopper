// The Windows sandbox steps' events (issue #731, design.md "Windows sandbox steps"): a step a job asked for, started on
// its Windows host, its end, or a no. On the job's timeline. Part of EVENT_SCHEMAS (schemas.ts). Never its output.
import { z } from 'zod';

const strict = z.strictObject;

export const WINDOWS_STEP_EVENT_SCHEMAS = {
  'step.started': strict({
    step: z.string(), host: z.string(), command: z.string(), timeoutSeconds: z.number().int().min(1),
    inputsBytes: z.number().int().min(0), outputs: z.array(z.string()),
  }),
  'step.finished': strict({
    step: z.string(), host: z.string(), exit: z.number().int(), seconds: z.number().int().min(0),
    outputsBytes: z.number().int().min(0).optional(), problem: z.string().optional(),
  }),
  'step.refused': strict({ reason: z.string(), host: z.string().optional() }),
} as const;
