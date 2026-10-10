// Payload (`data`) schema per event type, plus the envelope. Strict: an undeclared key fails,
// so a field an emitter adds without declaring it breaks the conformance test.
// Additive (optional) field → same version; removed/renamed/retyped → bump
// EVENT_SCHEMA_VERSIONS in src/domain/types.ts and move the old schema to legacy.ts (its
// docs/schemas file stays, re-exported from there).
import { z } from 'zod';
import { CONNECTED_ACCOUNT_PROVIDERS, DECISION_POINTS, MINOR_DECISION_MODES, NOT_APPLIED, EVENT_SCHEMA_VERSIONS, EVENT_TYPES, FAILURE_CLASSES, FAILURE_DECISIONS, GATE_AT, HANDOFF_ENDS, HANDOFF_REASONS, HANDOFF_RESOLUTIONS, LOGIN_KINDS, PRIORITY_LANE_IDLE, QUEUE_GATE_MODES, RADIUS_LEVELS, OPERATIONS, ASSET_KINDS, REVIEW_DECISIONS, REVIEW_SECTIONS, REVIEW_VERDICTS, ROLES, SESSION_END_REASONS, UNCONFIRMED_AS, type EventType, type ReviewKind, FORK_PARENT, JOB_PHASES, REVIEW_KINDS, SHIFT_MODES, SHIFT_THEN } from '../domain/types.ts';
import { LEGACY_EVENT_SCHEMAS, LEGACY_EVENT_TYPES } from './legacy.ts';
import { PROXY_OPS } from '../github-proxy/policy.ts';
import { advice, adviceAction, holdPlan, waitPlan, jobSourceRef, jobSpec, jobStatus, specFromConfig, lanePlan, startPlan } from './parts.ts';

const strict = z.strictObject;
const decisionPoint = z.enum(DECISION_POINTS);
const decisionPointSettings = z.strictObject({ mode: z.enum(MINOR_DECISION_MODES), threshold: z.number().min(0).max(1) });
const gateActor = z.enum(['user', 'pre-sort']);
const queueGate = strict({ mode: z.enum(QUEUE_GATE_MODES), autoAcceptPerHour: z.number().int().min(1).nullable() });
/** Who asked the GitHub proxy (issue #563): the request, the job's machine, whether the job is the hopper's own user's. */
const skillAsked = { requestId: z.string(), machine: z.string().optional(), template: z.string().optional(), asset: z.string().optional() };
const proxyAsked = { requestId: z.string(), machine: z.string().optional(), own: z.boolean(), forUser: z.string().optional(), job: z.string().optional() };
const proxyOp = z.enum(PROXY_OPS);
/** A question stage: an escalation level's instance name, or `human`. */
const stage = z.string().min(1);
// Additive on every question event (issue #485): the raising machine, the question's snapshot. Absent: not known.
const raisedBy = strict({ machineId: z.string(), name: z.string().optional(), laneId: z.string().optional() }).optional();

/**
 * A review section's events (issues #537, #543), the same for every one: a job asked for one, the item and each version
 * (`<first part>`: its first part, a proposal's goal, a report's question), its review by the reviewer levels and a
 * person, and its sign-off. Every one but `<prefix>.asked` names its item (`proposalId`, `researchId`) and the version
 * it is at, and the raising machine, as question events do; `priority`, `high`: the job's live priority.
 */
function reviewEvents(kind: ReviewKind) {
  const t = REVIEW_SECTIONS[kind];
  const first = t.parts[0]!.id;
  const item = { [t.idField]: z.string(), version: z.number().int().min(1), raisedBy, priority: z.number().optional(), high: z.boolean().optional() };
  const headline = { [first]: z.string().optional() };
  return {
    asked: strict({ by: z.enum(['user']) }),
    submitted: strict({ ...item, ...headline, missing: z.array(z.enum(t.parts.map((p) => p.id) as [string, ...string[]])) }),
    escalated: strict({ ...item, target: stage, reason: z.string(), ...headline }),
    escalated_to_human: strict({ ...item, reason: z.string() }),
    reviewed: strict({ ...item, stage, verdict: z.enum(REVIEW_VERDICTS), notes: z.string(), error: z.string().optional() }),
    // `decision`: what sent it back — a level's or a person's request for changes, a person's dig deeper or steer (additive).
    revision_requested: strict({ ...item, stage, decision: z.enum(REVIEW_DECISIONS).optional(), notes: z.string(), by: z.string().optional() }),
    // `then` (issue #548, additive): accepted in a switched phase, what the person picked for the job next.
    accepted: strict({ ...item, stage, by: z.string().optional(), notes: z.string().optional(), then: z.enum(SHIFT_THEN).optional() }),
    rejected: strict({ ...item, stage, by: z.string().optional(), notes: z.string().optional() }),
    cancelled: strict({ ...item, reason: z.string() }),
  };
}
const proposal = reviewEvents('proposal');
const research = reviewEvents('research');

// Every auth event (issue #476) names its login, its kind and its tool; never the login's URL or code.
const login = { loginId: z.string(), kind: z.enum(LOGIN_KINDS), tool: z.string().min(1) };

// Additive (issue #535): the job's live priority, and whether it is high priority, on what waits on a job or tells of it.
const priority = { priority: z.number().optional(), high: z.boolean().optional() };
const priorityLaneSettings = strict({
  highPriority: z.number(), count: z.number().int(), whenIdle: z.enum(PRIORITY_LANE_IDLE), windowDays: z.number(), minRuns: z.number().int(),
  manual: z.array(z.string()).optional(),
});

// Blast radius (issue #542): a level, what a discovery changed, the settings an admin saves.
const radiusLevel = z.enum(RADIUS_LEVELS);
/** An operation on an asset (issues #559, #584). */
const operationProfile = strict({ operation: z.enum(OPERATIONS), asset: strict({ kind: z.enum(ASSET_KINDS), name: z.string() }) });
const discoveryChanges = strict({
  first: z.boolean(), added: z.array(z.string()), removed: z.array(z.string()), level: strict({ from: radiusLevel, to: radiusLevel }).optional(),
});
const blastRadiusSettings = strict({
  gateAt: z.enum(GATE_AT),
  pass: strict({ labels: z.array(z.string()), repos: z.array(z.string()), minPriority: z.number().int().optional() }),
  rules: strict({ prodPatterns: z.array(z.string()), prodAccounts: z.array(z.string()), unconfirmed: z.enum(UNCONFIRMED_AS) }),
  actors: z.array(strict({ machineId: z.string(), purpose: z.string(), expected: radiusLevel })),
  everyMinutes: z.number().int(),
});

const usageLimits = strict({ soft: z.number().min(0).max(1), hard: z.number().min(0).max(1) });

const problemScope = strict({ machineId: z.string().optional(), executor: z.string().optional() });

const divergence = strict({
  jobId: z.string(), advice: adviceAction,
  native: z.enum(['start', 'hold']), withAdvice: z.enum(['start', 'hold']), note: z.string(),
});

// Phase shifts (issue #548): a phase, a review kind, the settings an admin saves.
const phase = z.enum(JOB_PHASES);
const reviewKind = z.enum(REVIEW_KINDS);
const yoloMode = strict({ on: z.boolean(), repos: z.record(z.string(), z.boolean()) });
const phaseShiftSettings = strict({ defaultMode: z.enum(SHIFT_MODES), forkParent: z.enum(FORK_PARENT), levels: z.array(z.string()) });

export const EVENT_SCHEMAS = {
  // `source`: the item the job was pulled from (phase 3; additive, so still v1). `forkOf`: a fork's parent job and
  // question, and what it was forked for (issue #548; additive).
  'job.queued': strict({
    spec: jobSpec, priority: z.number(), source: jobSourceRef.optional(),
    forkOf: strict({ jobId: z.string(), questionId: z.string(), kind: reviewKind }).optional(),
  }),
  // v3: no `mode` (issue #211: the advice is always applied). v2: advice without top-level `jevUsed`.
  'job.prioritized': strict({ advice, statusAtAdvice: jobStatus }),
  'job.held': strict({ reason: z.string() }),
  'job.approved': strict({}),
  'job.claimed': strict({ attempts: z.number().int(), effectivePriority: z.number(), reason: z.string() }),
  'job.started': strict({ attempts: z.number().int() }),
  'job.progressed': strict({ progress: z.number().min(0).max(1), message: z.string().optional() }),
  // `partlyDone` (issue #579, additive): the URL of the job's own pull request that ships part of its item.
  'job.finished': strict({ result: z.unknown(), partlyDone: z.string().optional() }),
  'job.failed': strict({ error: z.string(), ...priority }),
  'job.cancelled': strict({ reason: z.string() }),
  'job.requeued': strict({ from: z.string(), reason: z.string() }),
  'job.parked': strict({ from: z.enum(['running', 'waiting_answer']), machineId: z.string().optional() }),
  'job.unparked': strict({ to: z.enum(['queued', 'waiting_answer']) }),
  'job.continued': strict({ handoffId: z.string() }),
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
  'question.asked': strict({ questionId: z.string(), text: z.string(), detectedBy: z.string(), raisedBy, ...priority }),
  // v2: `target` is the stage entered (an instance name or `human`), no longer opus | fable | human.
  'question.escalated': strict({
    questionId: z.string(), target: stage, reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string().optional(),
    notifyCount: z.number().int().optional(), renotify: z.boolean().optional(),
    // Additive (issue #376): the question is a dialog the agent denies by itself at this time.
    lapsesAt: z.string().optional(),
    raisedBy, ...priority,
  }),
  // Only the human stage, once per question reaching it; never a level hop or a re-notification.
  'question.escalated_to_human': strict({
    questionId: z.string(), reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string(), notifyCount: z.number().int(),
    lapsesAt: z.string().optional(), raisedBy, ...priority,
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
  'auth.pending': strict({ ...login, expiresAt: z.iso.datetime(), intervalSec: z.number().int().positive().optional(), run: z.string(), questionId: z.string().optional(), renewed: z.boolean().optional(), ...priority }),
  'auth.completed': strict(login),
  'auth.expired': strict({ ...login, expiresAt: z.iso.datetime() }),
  'auth.cancelled': strict({ ...login, by: z.enum(['user']) }),
  'auth.failed': strict({ ...login, reason: z.string().min(1) }),
  // The failure assessor (issue #509): its judgement of a failed job, and the problems it groups shared causes into.
  'job.assessed': strict({
    recordId: z.string(), signature: z.string(), class: z.enum(FAILURE_CLASSES), decision: z.enum(FAILURE_DECISIONS),
    reasons: z.array(z.string()), summary: z.string(), attempt: z.number().int().min(1), auto: z.boolean(),
    causeId: z.string().optional(), problemId: z.string().optional(), retryAt: z.iso.datetime().optional(), ...priority,
  }),
  'failure.grouped': strict({
    problemId: z.string(), signature: z.string(), title: z.string(), opened: z.boolean(), general: z.boolean(),
    decision: z.enum(['hold', 'redirect']), scope: problemScope, affected: z.number().int().min(1),
  }),
  'failure.resolved': strict({ problemId: z.string(), title: z.string(), by: z.enum(['user', 'check']), released: z.number().int().min(0) }),
  // Needs a person (issue #516): a failed job handed off to a person, and the hand-off ending.
  'handoff.opened': strict({
    handoffId: z.string(), reason: z.enum(HANDOFF_REASONS), summary: z.string(), notify: z.boolean(),
    recordId: z.string().optional(), decision: z.enum(FAILURE_DECISIONS).optional(), class: z.enum(FAILURE_CLASSES).optional(), ...priority,
  }),
  'handoff.closed': strict({ handoffId: z.string(), end: z.enum(HANDOFF_ENDS), nextJobId: z.string().optional(), resolution: z.enum(HANDOFF_RESOLUTIONS).optional() }),
  // The usage limits set in the UI (issue #522): what the decider used before, and what it uses from now on.
  'usage.limits_changed': strict({ from: usageLimits, to: usageLimits }),
  // Priority lanes (issue #535): the lanes high-priority jobs get first changed, chosen by reliability, by an admin,
  // or by a settings change; and the settings an admin saved.
  'priority_lanes.changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.enum(['reliability', 'manual', 'settings']) }),
  'priority_lanes.settings_changed': strict({ from: priorityLaneSettings, to: priorityLaneSettings }),
  // Proposals (issue #537) and Research (issue #543): review sections, their events built alike (reviewEvents).
  'proposal.asked': proposal.asked,
  'proposal.submitted': proposal.submitted,
  'proposal.escalated': proposal.escalated,
  'proposal.escalated_to_human': proposal.escalated_to_human,
  'proposal.reviewed': proposal.reviewed,
  'proposal.revision_requested': proposal.revision_requested,
  'proposal.accepted': proposal.accepted,
  'proposal.rejected': proposal.rejected,
  'proposal.cancelled': proposal.cancelled,
  'research.asked': research.asked,
  'research.submitted': research.submitted,
  'research.escalated': research.escalated,
  'research.escalated_to_human': research.escalated_to_human,
  'research.reviewed': research.reviewed,
  'research.revision_requested': research.revision_requested,
  'research.accepted': research.accepted,
  'research.cancelled': research.cancelled,
  // Blast radius (issue #542): a machine's discovery changed what it holds, or could not run; a discovery raised its
  // level; an actor machine's rating is not the level declared for it; an admin saved the settings; a person let a job
  // held at the gate through.
  'machine.discovered': strict({ machineId: z.string(), level: radiusLevel, changes: discoveryChanges }),
  'machine.discovery_failed': strict({ machineId: z.string(), error: z.string() }),
  'machine.radius_grew': strict({ machineId: z.string(), from: radiusLevel, to: radiusLevel }),
  'machine.actor_mismatch': strict({ machineId: z.string(), expected: radiusLevel, found: radiusLevel }),
  'blast_radius.settings_changed': strict({ from: blastRadiusSettings, to: blastRadiusSettings }),
  'job.gate_passed': strict({ reason: z.string().optional() }),
  // Minor decisions (issue #550): Jev picked (or failed to), what was decided after it compared with its pick, a
  // person's override of one, an admin's change to a decision point's settings.
  'minor_decision.picked': strict({
    pickId: z.string(), point: decisionPoint, by: z.literal('jev'), options: z.array(strict({ id: z.string(), label: z.string() })),
    pick: z.string().optional(), confidence: z.number().min(0).max(1).optional(), error: z.string().optional(),
    mode: z.enum(MINOR_DECISION_MODES), threshold: z.number().min(0).max(1), applied: z.boolean(),
    notApplied: z.enum(NOT_APPLIED).optional(), consequential: z.array(z.string()).optional(), questionId: z.string().optional(),
  }),
  'minor_decision.compared': strict({ pickId: z.string(), point: decisionPoint, pick: z.string(), actual: z.string(), agreed: z.boolean(), decidedBy: z.string() }),
  'minor_decision.overridden': strict({ pickId: z.string(), point: decisionPoint, pick: z.string().optional(), actual: z.string() }),
  'minor_decision.settings_changed': strict({ point: decisionPoint, from: decisionPointSettings, to: decisionPointSettings }),
  // Phase shifts (issue #548): a job moved into or out of a phase; a fork spun off a question, and its result.
  'job.phase_changed': strict({
    from: phase, to: phase, reason: z.string(), mode: z.enum(['switch']).optional(), questionId: z.string().optional(), note: z.string().optional(), by: z.string().optional(),
  }),
  'job.forked': strict({
    forkId: z.string(), to: reviewKind, mode: z.literal('fork'), questionId: z.string(), note: z.string().optional(), by: z.string(),
    parent: z.enum(['waiting', 'parked']), ...priority,
  }),
  'job.fork_resolved': strict({ forkId: z.string(), kind: reviewKind, questionId: z.string(), decision: z.enum(['accept', 'reject']), delivered: z.boolean(), question: z.enum(['open', 'answered', 'closed', 'dismissed', 'expired', 'lapsed', 'cancelled', 'missing']).optional() }),
  'phase_shifts.settings_changed': strict({ from: phaseShiftSettings, to: phaseShiftSettings }),
  // The vault (issue #558): names and people; never a value.
  // After done (issue #579): the job's pull request, followed after its end, merged or closed without a merge.
  'job.pull_request_merged': strict({ pullRequest: z.string(), part: z.boolean() }),
  'job.pull_request_closed': strict({ pullRequest: z.string(), part: z.boolean() }),
  // Yolo mode (issue #579): the settings before and after, and who changed them.
  'yolo_mode.changed': strict({ from: yoloMode, to: yoloMode, by: z.string() }),
  'vault.secret_set': strict({ name: z.string(), by: z.string(), replaced: z.boolean(), backend: z.string().optional() }),
  'vault.secret_removed': strict({ name: z.string(), by: z.string() }),
  'template.saved': strict({ template: z.string(), image: z.string(), secrets: z.array(z.string()), profiles: z.array(operationProfile).optional(), by: z.string() }),
  'template.removed': strict({ template: z.string(), by: z.string() }),
  'vault.approved': strict({ template: z.string(), image: z.string(), secrets: z.array(z.string()), by: z.string() }),
  'vault.revoked': strict({ template: z.string(), by: z.string() }),
  'template.profile_approved': strict({ template: z.string(), ...operationProfile.shape, level: radiusLevel, by: z.string() }),
  'vault.delivered': strict({ name: z.string(), template: z.string(), machine: z.string(), job: z.string(), backend: z.string().optional() }),
  'vault.refused': strict({ name: z.string(), machine: z.string(), template: z.string().optional(), job: z.string().optional(), backend: z.string().optional(), reason: z.string() }),
  // The dynamic vault (issue #583): a credential request asked, given or declined. Never a value.
  'vault.credential_asked': strict({ request: z.string(), skill: z.string(), template: z.string(), machine: z.string(), job: z.string(), why: z.string().optional() }),
  'vault.credential_given': strict({ request: z.string(), skill: z.string(), name: z.string(), kind: z.string(), template: z.string(), by: z.string(), approved: z.boolean(), jobs: z.array(z.string()) }),
  'vault.credential_declined': strict({ request: z.string(), skill: z.string(), template: z.string(), reason: z.string(), by: z.string(), jobs: z.array(z.string()) }),
  // The GitHub proxy (issue #563): a job's request done, refused, or failed at GitHub. On the job's timeline; for
  // another user's job also in the log of the user whose GitHub connection the hopper acts with (`forUser`, `job`).
  'github_proxy.done': strict({ ...proxyAsked, op: proxyOp, repo: z.string(), number: z.number().int(), url: z.string() }),
  'github_proxy.refused': strict({ ...proxyAsked, op: z.string().optional(), repo: z.string().optional(), reason: z.string() }),
  'github_proxy.failed': strict({ ...proxyAsked, op: proxyOp, repo: z.string(), error: z.string() }),
  // Skills (issue #582): what a running job asked the hopper to set up, and the answer. On the job's timeline;
  // `decision` names Access's decision (issue #559) when a link was checked.
  'skill.listed': strict(skillAsked),
  'skill.loaded': strict({ ...skillAsked, skill: z.string(), decision: z.string().optional() }),
  'skill.refused': strict({ ...skillAsked, skill: z.string(), reason: z.string(), decision: z.string().optional() }),
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
