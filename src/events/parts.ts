// Payload building blocks shared by the current schemas (schemas.ts) and the superseded ones
// (legacy.ts).
import { z } from 'zod';

const strict = z.strictObject;

export const jobSourceRef = strict({
  source: z.string(), kind: z.string(), key: z.string(),
  url: z.string().optional(), title: z.string().optional(), repo: z.string().optional(),
  number: z.number().int().optional(), author: z.string().optional(), assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
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
  // The routing rule that set the machine, executor, priority or work tree at intake (issue #18, #324; additive).
  routedBy: strict({
    rule: z.string(),
    set: strict({ machine: z.string().optional(), executor: z.string().optional(), priority: z.number().optional(), workTree: z.string().optional() }),
  }).optional(),
  // Asked for a proposal (issue #537; additive).
  proposal: z.literal(true).optional(),
  // Asked to research (issue #543; additive).
  research: z.literal(true).optional(),
});

// What a job's source and routing rules give its spec (issue #375). `defaultCwd` only in events recorded before issue #361.
export const specFromConfig = strict({
  executor: z.string(), model: z.string().optional(), cwd: z.string().optional(), defaultCwd: z.string().optional(),
  machineId: z.string().optional(), rule: z.string().optional(),
});

export const adviceAction = z.enum([
  'proceed_full', 'reuse_cache', 'stop_retry', 'run_deterministic',
  'chat_only', 'ask_human', 'allow_subagent', 'research_capped',
]);
export const advice = strict({
  action: adviceAction, reason: z.string(), details: z.record(z.string(), z.unknown()),
  source: z.string(), at: z.string(),
});
export const jobStatus = z.enum(['queued', 'held', 'claimed', 'running', 'waiting_answer', 'operator_led', 'parked', 'waiting_on', 'finished', 'failed', 'cancelled', 'rejected']);

export const startPlan = strict({
  jobId: z.string(), laneId: z.string().nullable(), machineId: z.string(),
  effectivePriority: z.number(), reason: z.string(),
  // Additive (issue #535): with `laneId` null, the lane to open — a priority lane, or one kept off them.
  opens: z.string().optional(),
});
export const holdPlan = strict({ jobId: z.string(), reason: z.string() });
export const waitPlan = strict({ jobId: z.string(), reason: z.string() });
/** A lane plan as decision.made v1 and v2 carried it. */
export const legacyLanePlan = strict({
  machineId: z.string(), current: z.number(), target: z.number(), open: z.number(),
  close: z.array(z.string()), drain: z.array(z.string()), reason: z.string(),
});
/** `idle` (issue #440): why the machine leaves lanes unused. */
export const lanePlan = legacyLanePlan.extend({ idle: z.string().optional() });
