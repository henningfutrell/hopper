// The sandbox steps' events (issue #731, design.md "Windows sandbox steps"; issue #1004, "Box steps"): a step a job asked
// for, started on its Windows host or in its box (one of the two), its end, or a no; a vault secret given to a Windows
// step, or refused. On the job's timeline. Part of EVENT_SCHEMAS (schemas.ts). Never its output.
import { z } from 'zod';

const strict = z.strictObject;

export const WINDOWS_STEP_EVENT_SCHEMAS = {
  'step.started': strict({
    step: z.string(), host: z.string().optional(), box: z.string().optional(), command: z.string(), timeoutSeconds: z.number().int().min(1),
    inputsBytes: z.number().int().min(0), outputs: z.array(z.string()), secrets: z.array(z.string()).optional(),
  }),
  'step.finished': strict({
    step: z.string(), host: z.string().optional(), box: z.string().optional(), exit: z.number().int(), seconds: z.number().int().min(0),
    outputsBytes: z.number().int().min(0).optional(), problem: z.string().optional(),
  }),
  'step.refused': strict({ reason: z.string(), host: z.string().optional(), box: z.string().optional() }),
  'vault.step_delivered': strict({ name: z.string(), host: z.string(), job: z.string(), backend: z.string().optional() }),
  'vault.step_refused': strict({ name: z.string(), host: z.string(), job: z.string(), backend: z.string().optional(), reason: z.string() }),
} as const;
