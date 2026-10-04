// Payload (`data`) schema per event type, plus the envelope. Strict: an undeclared key fails,
// so a field an emitter adds without declaring it breaks the conformance test.
// Additive (optional) field → same version; removed/renamed/retyped → bump
// EVENT_SCHEMA_VERSIONS in src/domain/types.ts and move the old schema to legacy.ts (its
// docs/schemas file stays, re-exported from there).
import { z } from 'zod';
import { EVENT_SCHEMA_VERSIONS, EVENT_TYPES, type EventType } from '../domain/types.ts';
import { LEGACY_EVENT_SCHEMAS, LEGACY_EVENT_TYPES } from './legacy.ts';
import { advice, adviceAction, holdPlan, jobSourceRef, jobSpec, jobStatus, lanePlan, startPlan } from './parts.ts';

const strict = z.strictObject;
const routerMode = z.enum(['shadow', 'active']);
/** A question stage: the answerer's or assessor's instance name, or `human`. */
const stage = z.string().min(1);

const divergence = strict({
  jobId: z.string(), advice: adviceAction,
  native: z.enum(['start', 'hold']), withAdvice: z.enum(['start', 'hold']), note: z.string(),
});

export const EVENT_SCHEMAS = {
  // `source`: the item the job was pulled from (phase 3; additive, so still v1).
  'job.queued': strict({ spec: jobSpec, priority: z.number(), source: jobSourceRef.optional() }),
  // v2: advice without top-level `jevUsed` (jev-router puts it in `details`).
  'job.prioritized': strict({ advice, mode: routerMode, statusAtAdvice: jobStatus }),
  'job.held': strict({ reason: z.string() }),
  'job.approved': strict({}),
  'job.claimed': strict({ attempts: z.number().int(), effectivePriority: z.number(), reason: z.string() }),
  'job.started': strict({ attempts: z.number().int() }),
  'job.progressed': strict({ progress: z.number().min(0).max(1), message: z.string().optional() }),
  'job.finished': strict({ result: z.unknown() }),
  'job.failed': strict({ error: z.string() }),
  'job.cancelled': strict({ reason: z.string() }),
  'job.requeued': strict({ from: z.string(), reason: z.string() }),
  'job.reattached': strict({ reason: z.string() }),
  'job.reprioritized': strict({ from: z.number(), to: z.number(), reason: z.string() }),
  'lane.opened': strict({}),
  'lane.closed': strict({ reason: z.string() }),
  'decision.made': strict({
    // v2: `routerMode` (was jevMode), divergences carry `withAdvice` (was withJev).
    decisionId: z.string(), trigger: z.string(), routerMode,
    starts: z.array(startPlan), holds: z.array(holdPlan), lanes: z.array(lanePlan), divergences: z.array(divergence),
  }),
  'router.mode_changed': strict({ from: routerMode, to: routerMode }),
  'question.asked': strict({ questionId: z.string(), text: z.string(), detectedBy: z.string() }),
  // v2: `target` is the stage entered (an instance name or `human`), no longer opus | fable | human.
  'question.escalated': strict({
    questionId: z.string(), target: stage, reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string().optional(),
    notifyCount: z.number().int().optional(), renotify: z.boolean().optional(),
  }),
  // v2: `by` is the answerer instance whose draft was accepted, or `human`.
  // `via: "pane"`: the owner typed it into the job's pane, not the UI (additive, still v2).
  'question.answered': strict({ questionId: z.string(), by: stage, answer: z.string(), via: z.literal('pane').optional() }),
  // `answer` is the close text typed into the job in place of an answer.
  'question.closed': strict({ questionId: z.string(), answer: z.string() }),
  // Nothing is typed into the job; a job still waiting on it is cancelled (job.cancelled, reason `question dismissed`).
  'question.dismissed': strict({ questionId: z.string() }),
  'question.expired': strict({ questionId: z.string(), after_ms: z.number() }),
  // Self-update (issue #44): commits are full shas; `ref` is the branch or the release tag.
  'update.available': strict({ from: z.string(), to: z.string(), ref: z.string(), changes: z.number().int() }),
  'update.started': strict({ from: z.string(), to: z.string(), ref: z.string() }),
  'update.applied': strict({ from: z.string(), to: z.string(), ref: z.string() }),
  'update.failed': strict({ to: z.string(), error: z.string() }),
} satisfies Record<EventType, z.ZodType>;

export const ENVELOPE_SCHEMA = strict({
  schemaVersion: z.number().int().min(1),
  seq: z.number().int(),
  id: z.uuid(),
  // Stored events of retired types (jev.mode_changed) still read; nothing emits them.
  type: z.enum([...EVENT_TYPES, ...LEGACY_EVENT_TYPES] as unknown as [string, ...string[]]),
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

/** The payload schema for (type, version): the current one, or a superseded one kept for stored events. */
function schemaFor(type: string, version: number): z.ZodType | undefined {
  const current = EVENT_SCHEMA_VERSIONS[type as EventType];
  if (current === version) return EVENT_SCHEMAS[type as EventType];
  return LEGACY_EVENT_SCHEMAS[`${type}.v${version}`];
}

/** Envelope, then `data` against the schema of its own type and schemaVersion (current or superseded). */
export function validateEvent(event: unknown): ValidationResult {
  const env = ENVELOPE_SCHEMA.safeParse(event);
  if (!env.success) return { ok: false, issues: issuesOf('envelope ', env.error) };
  const { type, schemaVersion, data } = env.data;
  const schema = schemaFor(type, schemaVersion);
  if (!schema) {
    const current = EVENT_SCHEMA_VERSIONS[type as EventType];
    return { ok: false, issues: [`envelope schemaVersion: ${schemaVersion} but ${type} is ${current ? `v${current}` : 'retired'}`] };
  }
  const d = schema.safeParse(data);
  return d.success ? { ok: true } : { ok: false, issues: issuesOf(`${type} data `, d.error) };
}
