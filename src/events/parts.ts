// Payload building blocks shared by the current schemas (schemas.ts) and the superseded ones
// (legacy.ts).
import { z } from 'zod';

const strict = z.strictObject;

export const jobSourceRef = strict({
  source: z.string(), kind: z.string(), key: z.string(),
  url: z.string().optional(), title: z.string().optional(), repo: z.string().optional(),
  number: z.number().int().optional(), author: z.string().optional(),
});

export const jobSpec = strict({
  executor: z.string(),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().optional(),
  goal: z.string().optional(),
  kind: z.string().optional(),
  submittedBy: z.string().optional(),
  machineId: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  // The routing rule that set the machine, executor or priority at intake (issue #18; additive).
  routedBy: strict({
    rule: z.string(),
    set: strict({ machine: z.string().optional(), executor: z.string().optional(), priority: z.number().optional() }),
  }).optional(),
});

export const adviceAction = z.enum([
  'proceed_full', 'reuse_cache', 'stop_retry', 'run_deterministic',
  'chat_only', 'ask_human', 'allow_subagent', 'research_capped',
]);
export const advice = strict({
  action: adviceAction, reason: z.string(), details: z.record(z.string(), z.unknown()),
  source: z.string(), at: z.string(),
});
export const jobStatus = z.enum(['queued', 'held', 'claimed', 'running', 'waiting_answer', 'operator_led', 'finished', 'failed', 'cancelled', 'rejected']);

export const startPlan = strict({
  jobId: z.string(), laneId: z.string().nullable(), machineId: z.string(),
  effectivePriority: z.number(), reason: z.string(),
});
export const holdPlan = strict({ jobId: z.string(), reason: z.string() });
export const lanePlan = strict({
  machineId: z.string(), current: z.number(), target: z.number(), open: z.number(),
  close: z.array(z.string()), drain: z.array(z.string()), reason: z.string(),
});
