// Payload (`data`) schema per event type, plus the envelope. Strict: an undeclared key fails,
// so a field an emitter adds without declaring it breaks the conformance test.
// Additive (optional) field → same version; removed/renamed/retyped → bump
// EVENT_SCHEMA_VERSIONS in src/domain/types.ts and keep the old docs/schemas file.
import { z } from 'zod';
import { EVENT_SCHEMA_VERSIONS, EVENT_TYPES, type EventType } from '../domain/types.ts';

const strict = z.strictObject;
const jevMode = z.enum(['shadow', 'active']);
const answerTier = z.enum(['opus', 'fable', 'human']);

const jobSourceRef = strict({
  source: z.string(), kind: z.string(), key: z.string(),
  url: z.string().optional(), title: z.string().optional(), repo: z.string().optional(),
  number: z.number().int().optional(), author: z.string().optional(),
});

const jobSpec = strict({
  executor: z.string(),
  payload: z.record(z.string(), z.unknown()),
  priority: z.number().optional(),
  goal: z.string().optional(),
  kind: z.string().optional(),
  submittedBy: z.string().optional(),
  machineId: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const jevAdvice = strict({
  action: z.enum([
    'proceed_full', 'reuse_cache', 'stop_retry', 'run_deterministic',
    'chat_only', 'ask_human', 'allow_subagent', 'research_capped',
  ]),
  reason: z.string(), jevUsed: z.boolean(), details: z.record(z.string(), z.unknown()),
  source: z.string(), at: z.string(),
});

const startPlan = strict({
  jobId: z.string(), laneId: z.string().nullable(), machineId: z.string(),
  effectivePriority: z.number(), reason: z.string(),
});
const holdPlan = strict({ jobId: z.string(), reason: z.string() });
const lanePlan = strict({
  machineId: z.string(), current: z.number(), target: z.number(), open: z.number(),
  close: z.array(z.string()), drain: z.array(z.string()), reason: z.string(),
});
const divergence = strict({
  jobId: z.string(), advice: jevAdvice.shape.action,
  native: z.enum(['start', 'hold']), withJev: z.enum(['start', 'hold']), note: z.string(),
});

export const EVENT_SCHEMAS = {
  // `source`: the item the job was pulled from (phase 3; additive, so still v1).
  'job.queued': strict({ spec: jobSpec, priority: z.number(), source: jobSourceRef.optional() }),
  'job.prioritized': strict({
    advice: jevAdvice, mode: jevMode,
    statusAtAdvice: z.enum(['queued', 'held', 'claimed', 'running', 'waiting_answer', 'finished', 'failed', 'cancelled']),
  }),
  'job.held': strict({ reason: z.string() }),
  'job.approved': strict({}),
  'job.claimed': strict({ attempts: z.number().int(), effectivePriority: z.number(), reason: z.string() }),
  'job.started': strict({ attempts: z.number().int() }),
  'job.progressed': strict({ progress: z.number().min(0).max(1), message: z.string().optional() }),
  'job.finished': strict({ result: z.unknown() }),
  'job.failed': strict({ error: z.string() }),
  'job.cancelled': strict({ reason: z.string() }),
  'job.requeued': strict({ from: z.string(), reason: z.string() }),
  'job.reprioritized': strict({ from: z.number(), to: z.number(), reason: z.string() }),
  'lane.opened': strict({}),
  'lane.closed': strict({ reason: z.string() }),
  'decision.made': strict({
    decisionId: z.string(), trigger: z.string(), jevMode,
    starts: z.array(startPlan), holds: z.array(holdPlan), lanes: z.array(lanePlan), divergences: z.array(divergence),
  }),
  'jev.mode_changed': strict({ from: jevMode, to: jevMode }),
  'question.asked': strict({ questionId: z.string(), text: z.string(), detectedBy: z.string() }),
  'question.escalated': strict({
    questionId: z.string(), target: answerTier, reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string().optional(),
    notifyCount: z.number().int().optional(), renotify: z.boolean().optional(),
  }),
  'question.answered': strict({ questionId: z.string(), by: answerTier, answer: z.string() }),
  'question.expired': strict({ questionId: z.string(), after_ms: z.number() }),
} satisfies Record<EventType, z.ZodType>;

export const ENVELOPE_SCHEMA = strict({
  schemaVersion: z.number().int().min(1),
  seq: z.number().int(),
  id: z.uuid(),
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  at: z.iso.datetime(),
  jobId: z.string().optional(),
  laneId: z.string().optional(),
  machineId: z.string().optional(),
  decisionId: z.string().optional(),
  questionId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

export type ValidationResult = { ok: true } | { ok: false; issues: string[] };

const issuesOf = (prefix: string, e: z.ZodError): string[] =>
  e.issues.map((i) => `${prefix}${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);

/** Envelope, then `data` for its type, then schemaVersion equals the type's current version. */
export function validateEvent(event: unknown): ValidationResult {
  const env = ENVELOPE_SCHEMA.safeParse(event);
  if (!env.success) return { ok: false, issues: issuesOf('envelope ', env.error) };
  const { type, schemaVersion, data } = env.data;
  const issues: string[] = [];
  if (schemaVersion !== EVENT_SCHEMA_VERSIONS[type]) {
    issues.push(`envelope schemaVersion: ${schemaVersion} but ${type} is v${EVENT_SCHEMA_VERSIONS[type]}`);
  }
  const d = EVENT_SCHEMAS[type].safeParse(data);
  if (!d.success) issues.push(...issuesOf(`${type} data `, d.error));
  return issues.length ? { ok: false, issues } : { ok: true };
}
