// The sandbox steps' events (issue #731, design.md "Windows sandbox steps"; issue #1004, "Box steps"; issue #1007, "Need
// steps"): a step a job asked for, started on its Windows host or in a box (one of the two), its end, or a no; a vault
// secret given to a Windows step, or refused. On the job's timeline. Part of EVENT_SCHEMAS (schemas.ts). Never its output.
import { z } from 'zod';

const strict = z.strictObject;

export const WINDOWS_STEP_EVENT_SCHEMAS = {
  'step.started': strict({
    step: z.string(), host: z.string().optional(), box: z.string().optional(), command: z.string(), timeoutSeconds: z.number().int().min(1),
    inputsBytes: z.number().int().min(0), outputs: z.array(z.string()), secrets: z.array(z.string()).optional(),
    // A need step (issue #1007): the template its need box (`box`) runs, and the needs the vault minted its credentials for.
    template: z.string().optional(), needs: z.array(z.string()).optional(),
  }),
  'step.finished': strict({
    step: z.string(), host: z.string().optional(), box: z.string().optional(), exit: z.number().int(), seconds: z.number().int().min(0),
    outputsBytes: z.number().int().min(0).optional(), outputsSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), problem: z.string().optional(),
  }),
  'step.refused': strict({ reason: z.string(), host: z.string().optional(), box: z.string().optional() }),
  // A step schedule's run (issue #2716) names its schedule in place of a job.
  'vault.step_delivered': strict({ name: z.string(), host: z.string(), job: z.string().optional(), schedule: z.string().optional(), backend: z.string().optional() }),
  'vault.step_refused': strict({ name: z.string(), host: z.string(), job: z.string().optional(), schedule: z.string().optional(), backend: z.string().optional(), reason: z.string() }),
} as const;
