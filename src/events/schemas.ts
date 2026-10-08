// Payload (`data`) schema per event type, plus the envelope. Strict: an undeclared key fails,
// so a field an emitter adds without declaring it breaks the conformance test.
// Additive (optional) field → same version; removed/renamed/retyped → bump
// EVENT_SCHEMA_VERSIONS in src/domain/types.ts and move the old schema to legacy.ts (its
// docs/schemas file stays, re-exported from there).
import { z } from 'zod';
import { CONNECTED_ACCOUNT_PROVIDERS, EVENT_SCHEMA_VERSIONS, FAILURE_CLASSES, FAILURE_DECISIONS, HANDOFF_ENDS, HANDOFF_REASONS, LOGIN_KINDS, EVENT_TYPES, QUEUE_GATE_MODES, ROLES, SESSION_END_REASONS, type EventType } from '../domain/types.ts';
import { LEGACY_EVENT_SCHEMAS, LEGACY_EVENT_TYPES } from './legacy.ts';
import { advice, adviceAction, holdPlan, waitPlan, jobSourceRef, jobSpec, jobStatus, specFromConfig, lanePlan, startPlan } from './parts.ts';

const strict = z.strictObject;
const gateActor = z.enum(['user', 'pre-sort']);
const queueGate = strict({ mode: z.enum(QUEUE_GATE_MODES), autoAcceptPerHour: z.number().int().min(1).nullable() });
/** A question stage: an escalation level's instance name, or `human`. */
const stage = z.string().min(1);
// Additive on every question event (issue #485): the raising machine, the question's snapshot. Absent: not known.
const raisedBy = strict({ machineId: z.string(), name: z.string().optional(), laneId: z.string().optional() }).optional();

// Every auth event (issue #476) names its login, its kind and its tool; never the login's URL or code.
const login = { loginId: z.string(), kind: z.enum(LOGIN_KINDS), tool: z.string().min(1) };

const problemScope = strict({ machineId: z.string().optional(), executor: z.string().optional() });

const divergence = strict({
  jobId: z.string(), advice: adviceAction,
  native: z.enum(['start', 'hold']), withAdvice: z.enum(['start', 'hold']), note: z.string(),
});

export const EVENT_SCHEMAS = {
  // `source`: the item the job was pulled from (phase 3; additive, so still v1).
  'job.queued': strict({ spec: jobSpec, priority: z.number(), source: jobSourceRef.optional() }),
  // v3: no `mode` (issue #211: the advice is always applied). v2: advice without top-level `jevUsed`.
  'job.prioritized': strict({ advice, statusAtAdvice: jobStatus }),
  'job.held': strict({ reason: z.string() }),
  'job.approved': strict({}),
  'job.claimed': strict({ attempts: z.number().int(), effectivePriority: z.number(), reason: z.string() }),
  'job.started': strict({ attempts: z.number().int() }),
  'job.progressed': strict({ progress: z.number().min(0).max(1), message: z.string().optional() }),
  'job.finished': strict({ result: z.unknown() }),
  'job.failed': strict({ error: z.string() }),
  'job.cancelled': strict({ reason: z.string() }),
  'job.requeued': strict({ from: z.string(), reason: z.string() }),
  'job.parked': strict({ from: z.enum(['running', 'waiting_answer']), machineId: z.string().optional() }),
  'job.unparked': strict({ to: z.enum(['queued', 'waiting_answer']) }),
  'job.reattached': strict({ reason: z.string() }),
  'job.reprioritized': strict({ from: z.number(), to: z.number(), reason: z.string() }),
  'job.respecified': strict({ from: specFromConfig, to: specFromConfig }),
  'lane.opened': strict({}),
  'lane.closed': strict({ reason: z.string() }),
  'decision.made': strict({
    // v3: no `routerMode` (issue #211). v2: divergences carry `withAdvice` (was withJev).
    decisionId: z.string(), trigger: z.string(),
    starts: z.array(startPlan), holds: z.array(holdPlan), lanes: z.array(lanePlan), divergences: z.array(divergence),
    // Additive (issue #381): the jobs left queued for want of a lane, with the lane cap that binds.
    waits: z.array(waitPlan).optional(),
  }),
  'question.asked': strict({ questionId: z.string(), text: z.string(), detectedBy: z.string(), raisedBy }),
  // v2: `target` is the stage entered (an instance name or `human`), no longer opus | fable | human.
  'question.escalated': strict({
    questionId: z.string(), target: stage, reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string().optional(),
    notifyCount: z.number().int().optional(), renotify: z.boolean().optional(),
    // Additive (issue #376): the question is a dialog the agent denies by itself at this time.
    lapsesAt: z.string().optional(),
    raisedBy,
  }),
  // Only the human stage, once per question reaching it; never a level hop or a re-notification.
  'question.escalated_to_human': strict({
    questionId: z.string(), reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string(), notifyCount: z.number().int(),
    lapsesAt: z.string().optional(), raisedBy,
  }),
  // v2: `by` is whose answer was typed: the escalation level instance that answered, or `human`.
  // `via: "pane"`: the owner typed it into the job's pane, not the UI (additive, still v2).
  'question.answered': strict({ questionId: z.string(), by: stage, answer: z.string(), via: z.literal('pane').optional(), raisedBy }),
  // `answer` is the close text typed into the job in place of an answer.
  'question.closed': strict({ questionId: z.string(), answer: z.string(), raisedBy }),
  // Nothing is typed into the job; a job still waiting on it is cancelled (job.cancelled, reason `question dismissed`).
  'question.dismissed': strict({ questionId: z.string(), raisedBy }),
  'question.expired': strict({ questionId: z.string(), after_ms: z.number(), raisedBy }),
  // Issue #376: nobody answered; the agent denied its dialog by itself when the countdown ran out.
  'question.lapsed': strict({ questionId: z.string(), lapsesAt: z.string(), raisedBy }),
  // Self-update (issue #44): commits are full shas; `ref` is the branch of the channel.
  'update.available': strict({ from: z.string(), to: z.string(), ref: z.string(), changes: z.number().int() }),
  'update.started': strict({ from: z.string(), to: z.string(), ref: z.string() }),
  'update.applied': strict({ from: z.string(), to: z.string(), ref: z.string() }),
  'update.failed': strict({ to: z.string(), error: z.string() }),
  // The plugin store (issue #75): `commit` is the store's full sha the plugin was installed from.
  'plugin.installed': strict({ id: z.string(), role: z.enum(ROLES), commit: z.string() }),
  'plugin.removed': strict({ id: z.string() }),
  // The queue gate (issue #159): `by` let the job through (the pre-sort, or the user), or turned it away.
  'job.accepted': strict({ by: gateActor }),
  'job.rejected': strict({ by: gateActor, reason: z.string().min(1) }),
  'queue.ordered': strict({ jobIds: z.array(z.string()) }),
  'queue.gate_changed': strict({ from: queueGate, to: queueGate }),
  // Operator-led work (issue #318): an operator took the waiting job by hand; it holds no lane and is never run.
  'job.claimed_by_operator': strict({}),
  // Run again (a re-run, issue #313): the user gave a failed job's item back to its source to run again.
  // `assessor` (issue #509): the failure assessor ran it again — a retry, a redirect, a release of a held job.
  'job.rerun': strict({ by: z.enum(['user', 'assessor']) }),
  // A locked entry dismissed (issue #355): the failed job stays failed, out of the queue.
  'job.dismissed': strict({ by: z.enum(['user']) }),
  'job.work_kept': strict({ paths: z.array(z.string()).min(1) }),
  'job.work_removed': strict({ paths: z.array(z.string()).min(1) }),
  // Issue #371: the job's cleanup could not reach its machine; it is tried again until it goes through.
  'job.cleanup_deferred': strict({ error: z.string() }),
  'job.cleaned_up': strict({ deferredAt: z.string(), by: z.enum(['user']).optional() }),
  // Assignment drift (issue #387): the started job's item is no longer, or again, assigned to the account it was taken for.
  'job.unassigned': strict({ assignee: z.string() }),
  'job.reassigned': strict({ assignee: z.string() }),
  // Intake stopped (issue #358): a job source in error past the stall threshold, and a connected account whose sign-in ended.
  'source.stalled': strict({ source: z.string(), kind: z.string(), error: z.string(), since: z.iso.datetime() }),
  'connected_account.expired': strict({ provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), account: z.string(), reason: z.string() }),
  // A UI session of the user's ended (issue #439), and why: early logouts can be told apart.
  'ui_session.ended': strict({ reason: z.enum(SESSION_END_REASONS), realm: z.string() }),
  // Intake (issue #440): a claim released, a source moved to the current intake rules, issues assigned to the user from Sources.
  'source.claim_released': strict({ source: z.string(), key: z.string(), by: z.enum(['hopper', 'migration', 'user']), reason: z.string() }),
  'source.intake_migrated': strict({ source: z.string(), changes: z.array(strict({ key: z.string(), change: z.string() })) }),
  'source.issues_assigned': strict({ source: z.string(), keys: z.array(z.string()), assignee: z.string() }),
  // Logins (issue #476): a login a job or run waits on, handled apart from questions. `run`: the executor or escalation level.
  'auth.pending': strict({ ...login, expiresAt: z.iso.datetime(), intervalSec: z.number().int().positive().optional(), run: z.string(), questionId: z.string().optional(), renewed: z.boolean().optional() }),
  'auth.completed': strict(login),
  'auth.expired': strict({ ...login, expiresAt: z.iso.datetime() }),
  'auth.cancelled': strict({ ...login, by: z.enum(['user']) }),
  'auth.failed': strict({ ...login, reason: z.string().min(1) }),
  // The failure assessor (issue #509): its judgement of a failed job, and the problems it groups shared causes into.
  'job.assessed': strict({
    recordId: z.string(), signature: z.string(), class: z.enum(FAILURE_CLASSES), decision: z.enum(FAILURE_DECISIONS),
    reasons: z.array(z.string()), summary: z.string(), attempt: z.number().int().min(1), auto: z.boolean(),
    causeId: z.string().optional(), problemId: z.string().optional(), retryAt: z.iso.datetime().optional(),
  }),
  'failure.grouped': strict({
    problemId: z.string(), signature: z.string(), title: z.string(), opened: z.boolean(), general: z.boolean(),
    decision: z.enum(['hold', 'redirect']), scope: problemScope, affected: z.number().int().min(1),
  }),
  'failure.resolved': strict({ problemId: z.string(), title: z.string(), by: z.enum(['user', 'check']), released: z.number().int().min(0) }),
  // Needs a person (issue #516): a failed job handed off to a person, and the hand-off ending.
  'handoff.opened': strict({
    handoffId: z.string(), reason: z.enum(HANDOFF_REASONS), summary: z.string(), notify: z.boolean(),
    recordId: z.string().optional(), decision: z.enum(FAILURE_DECISIONS).optional(), class: z.enum(FAILURE_CLASSES).optional(),
  }),
  'handoff.closed': strict({ handoffId: z.string(), end: z.enum(HANDOFF_ENDS), nextJobId: z.string().optional() }),
} satisfies Record<EventType, z.ZodType>;

export const ENVELOPE_SCHEMA = strict({
  schemaVersion: z.number().int().min(1),
  seq: z.number().int(),
  id: z.uuid(),
  // Stored events of retired types (jev.mode_changed, router.mode_changed) still read; nothing emits them.
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
