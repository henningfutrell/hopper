// Payload building blocks shared by the current schemas (schemas.ts) and the superseded ones
// (legacy.ts).
import { z } from 'zod';
import { CLOUD_OUTGOING, CLOUD_REFUSALS } from '../domain/cloud-link.ts';
import { ACTION_VIAS } from '../domain/failures.ts';
import { JOB_ORIGINS, ORIGIN_ROLES } from '../domain/intake-origin.ts';
import { REPO_VISIBILITIES } from '../domain/linked-pulls.ts';
import { MODEL_CHOICES, WORK_KINDS, WORK_RISKS, WORK_SIZES } from '../domain/model-routing.ts';
import { POINTED_JOB_STATUSES, POINTER_KINDS } from '../domain/pointed-jobs.ts';
import { TELEMETRY_SIGNALS } from '../domain/telemetry-settings.ts';
import { CONFIDENCES, RISK_CATEGORIES, RISK_LEVELS } from '../domain/types.ts';
// Infra plans (issue #870): their own file, spread with the other features' events.
export { INFRA_PLAN_EVENT_SCHEMAS as infraPlanEvents } from './infra-plan-schemas.ts';
export { API_GRANT_EVENT_SCHEMAS as apiGrantEvents } from './api-grant-schemas.ts';
export { WINDOWS_STEP_EVENT_SCHEMAS as windowsStepEvents } from './windows-step-schemas.ts';
export { SANDBOX_REQUEST_EVENT_SCHEMAS as sandboxRequestEvents } from './sandbox-request-schemas.ts';
export { LANDING_BATCH_EVENT_SCHEMAS as landingBatchEvents } from './landing-batch-schemas.ts';

const strict = z.strictObject;

export const jobSourceRef = strict({
  source: z.string(), kind: z.string(), key: z.string(),
  url: z.string().optional(), title: z.string().optional(), repo: z.string().optional(),
  number: z.number().int().optional(), author: z.string().optional(), assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  // Issue #652: a trusted origin, or an approved request card.
  origin: z.enum(JOB_ORIGINS).optional(),
  // Issue #655 part 14: its origin acts, as read when its origin was judged.
  originActs: z.array(strict({ role: z.enum(ORIGIN_ROLES), login: z.string().optional(), id: z.number().int().optional(), app: z.string().optional(), trusted: z.boolean() })).optional(),
  // Issue #655 part 19: its repository's visibility and its linked pull requests, as read when its origin was judged.
  visibility: z.enum(REPO_VISIBILITIES).optional(),
  linkedPulls: z.array(strict({ url: z.string(), author: z.string().optional(), fork: z.boolean().optional(), trusted: z.boolean(), unread: z.literal(true).optional() })).optional(),
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
  // Grade-aware routing gave it its executor (issue #2845; additive).
  gradeRoute: strict({
    executor: z.string(), from: z.string(), on: z.enum(['repo', 'kind']), score: z.number(), samples: z.number().int(),
    fromScore: z.number(), fromSamples: z.number().int(),
  }).optional(),
  // Asked for a proposal (issue #537; additive).
  proposal: z.literal(true).optional(),
  // Asked to research (issue #543; additive).
  research: z.literal(true).optional(),
  // Designated specialty: it may elbow in past a machine's lane cap (issue #762; additive).
  specialty: z.literal(true).optional(),
  // A tend job: it elbows in as a specialty job does (issue #967; additive).
  tend: z.literal(true).optional(),
  // What model routing chose at intake (issue #2848; additive).
  modelRoute: strict({
    choice: z.enum(MODEL_CHOICES), model: z.string(), rule: z.string(), why: z.string(),
    size: z.enum(WORK_SIZES), kind: z.enum(WORK_KINDS), risk: z.enum(WORK_RISKS),
    budget: strict({ jobTokens: z.number(), jobCostUsd: z.number() }),
    escalated: strict({ from: z.enum(MODEL_CHOICES), jobId: z.string() }).optional(),
  }).optional(),
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
/** What a job's own wait waits on (issue #1245, `WaitOn`). */
export const waitOn = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('pull_request'), repo: z.string().optional(), number: z.number().int(), about: z.enum(['checks', 'merge', 'review']) }),
  strict({ kind: z.literal('job'), jobId: z.string() }),
  strict({ kind: z.literal('item'), repo: z.string().optional(), number: z.number().int() }),
  strict({ kind: z.literal('question'), questionId: z.string() }),
  strict({ kind: z.literal('approval'), of: z.enum(['sandbox', 'template']) }),
  strict({ kind: z.literal('grant') }),
  // Additive (issue #2205): a person's approval of an infra plan.
  strict({ kind: z.literal('plan'), planId: z.string() }),
  strict({ kind: z.literal('own_command') }),
  // Additive (issue #1510): why a person acts; absent, the job did not say.
  strict({ kind: z.literal('outside'), what: z.string(), why: z.enum(['not_managed', 'gated']).optional() }),
]);
/** A lane plan as decision.made v1 and v2 carried it. */
export const legacyLanePlan = strict({
  machineId: z.string(), current: z.number(), target: z.number(), open: z.number(),
  close: z.array(z.string()), drain: z.array(z.string()), reason: z.string(),
});
/** `idle` (issue #440): why the machine leaves lanes unused. */
export const lanePlan = legacyLanePlan.extend({ idle: z.string().optional() });

// Report a bug (issue #694): what was filed, failed or kept to send later, never its text.
export const bugReportEvents = {
  'bug_report.filed': strict({ repo: z.string(), kind: z.enum(['issue', 'comment']), number: z.number().int(), url: z.string(), jobId: z.string().optional(), by: z.string(), fromJob: z.literal(true).optional(), id: z.string().optional(), later: z.literal(true).optional() }),
  'bug_report.failed': strict({ repo: z.string(), error: z.string(), jobId: z.string().optional(), by: z.string(), fromJob: z.literal(true).optional() }),
  'bug_report.kept': strict({ repo: z.string(), id: z.string(), problem: z.string(), jobId: z.string().optional(), by: z.string(), fromJob: z.literal(true).optional() }),
};

// Repositories with no checks (issue #677): the Add PR checks job queued, the recommendation dismissed.
export const repoChecksEvents = {
  'repo_checks.job_queued': strict({ repo: z.string(), number: z.number().int(), url: z.string(), existing: z.boolean(), by: z.string() }),
  'repo_checks.dismissed': strict({ repo: z.string(), dismissed: z.boolean(), by: z.string() }),
};

// Issue lineage (issue #729, src/github-proxy/broker.ts): a job filed an issue through the hopper, a child of the job's own
// issue — a follow-up, or a required child the hopper linked as a GitHub sub-issue (`subIssue`; `subIssueError`: GitHub refused the link).
const issueRef = strict({ repo: z.string(), number: z.number().int() });
/** Contribution (issue #429): an admin turned it on or off, and who. */
export const contributionEvents = {
  'credential_check.changed': strict({ from: strict({ strict: z.boolean() }), to: strict({ strict: z.boolean() }), by: z.string() }),
  'contribution.changed': strict({ from: strict({ on: z.boolean() }), to: strict({ on: z.boolean() }), by: z.string() }),
  // The shrink guard's percent (issue #1096).
  'shrink_guard.changed': strict({ from: strict({ percent: z.number().int() }), to: strict({ percent: z.number().int() }), by: z.string() }),
};

export const issueLineageEvents = {
  'job.child_issue_filed': strict({
    requestId: z.string(), parent: issueRef, child: strict({ ...issueRef.shape, url: z.string() }), required: z.boolean(),
    subIssue: z.boolean().optional(), subIssueError: z.string().optional(),
    // Additive (issue #1510): the hopper labelled the required child and assigned it to the job's user.
    routed: z.literal(true).optional(),
    // Additive (issue #1856): the assignees GitHub did not set on the routed child, after a second try.
    unassigned: z.array(z.string()).optional(),
  }),
  // A required child's sub-issue link made at a later try (issue #1607): GitHub refused it, or the hopper stopped, as it was filed.
  'job.sub_issue_linked': strict({ requestId: z.string(), parent: issueRef, child: strict({ ...issueRef.shape, url: z.string() }) }),
};

// Vault grants (issue #652, src/vault/grants.ts): a job on a box asked the vault with no grant, a person granted its item
// the vault, a person took the grant back. Never a value.
export const vaultGrantEvents = {
  'vault.grant_asked': strict({ job: z.string(), key: z.string(), machine: z.string().optional(), template: z.string().optional(), windowsHost: z.string().optional(), box: z.string().optional(), name: z.string() }),
  'vault.granted': strict({ job: z.string(), key: z.string(), by: z.string() }),
  'vault.grant_revoked': strict({ job: z.string(), key: z.string(), by: z.string() }),
  'vault.grant_denied': strict({ job: z.string(), key: z.string(), by: z.string() }),
};

// The shared rate limiter (issue #436): the hopper's admin changed its settings.
const remoteAccessProvider = z.enum(['cloudflare', 'ngrok']);
const remoteAccessSettings = strict({
  enabled: z.boolean(), provider: remoteAccessProvider.optional(), domain: z.string().optional(), restartedAt: z.string().optional(),
  provisioned: z.union([
    strict({ provider: z.literal('ngrok'), domain: z.string(), credentialId: z.string().optional(), reservedDomainId: z.string().optional() }),
    strict({ provider: z.literal('cloudflare'), domain: z.string(), accountId: z.string(), zoneId: z.string(), tunnelId: z.string(), dnsRecordId: z.string() }),
  ]).optional(),
  leftover: z.array(z.string()).optional(),
});
// `intakeReserve` (issue #983), `intakeSyncMinutes` and `prCycleMinutes` (issue #985) are absent from a change made before them.
const rateLimiterSettings = strict({ slowBelowPercent: z.number().int().min(0).max(100), reserve: z.number().int().min(0), batchSize: z.number().int().min(1), intakeReserve: z.number().int().min(0).optional(), intakeSyncMinutes: z.number().int().min(1).optional(), prCycleMinutes: z.number().int().min(1).optional() });
const telemetrySettings = strict({ on: z.boolean(), endpoint: z.string(), signals: z.array(z.enum(TELEMETRY_SIGNALS)) });
export const rateLimiterEvents = {
  'github_rate_limiter.settings_changed': strict({ from: rateLimiterSettings, to: rateLimiterSettings, by: z.string() }),
  'remote_access.changed': strict({ from: remoteAccessSettings, to: remoteAccessSettings, credential: z.enum(['set', 'removed']).optional(), by: z.string() }),
  'allowed_hosts.changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.string() }),
  'telemetry.changed': strict({ from: telemetrySettings, to: telemetrySettings, by: z.string() }),
  'cloud_link.linked': strict({ installId: z.string(), account: z.string(), by: z.string() }),
  'cloud_link.unlinked': strict({ installId: z.string(), account: z.string(), by: z.string() }),
  'cloud_link.registration_code_minted': strict({ installId: z.string(), account: z.string(), expiresAt: z.string(), by: z.string() }),
  'cloud_link.registered': strict({ installId: z.string(), account: z.string() }),
  'cloud_link.unregistered': strict({ installId: z.string(), account: z.string() }),
  'cloud_link.message_refused': strict({ reason: z.enum(['too-large', 'not-json', 'unknown-type', 'bad-shape', 'too-many']) }),
  'cloud_link.connected': strict({ installId: z.string(), account: z.string() }),
  'cloud_link.disconnected': strict({ installId: z.string(), account: z.string(), code: z.number().int() }),
  'cloud_link.connection_refused': strict({ installId: z.string(), account: z.string(), reason: z.enum(CLOUD_REFUSALS) }),
  'cloud_link.revoked': strict({ installId: z.string(), account: z.string(), by: z.string() }),
  'cloud_link.message_dropped': strict({ message: z.enum(CLOUD_OUTGOING), reason: z.enum(['secret', 'too-large']) }),
  'source_email_match.changed': strict({ on: z.boolean(), by: z.string() }),
  'display_name.changed': strict({ from: z.string(), to: z.string(), by: z.string() }),
};

// Pointed jobs (issue #425, src/http/ui/pointed-jobs.ts): a pointed job made, and each move of its status.
const pointedJobStatus = z.enum(POINTED_JOB_STATUSES);
export const pointedJobEvents = {
  'pointed_job.created': strict({ id: z.string(), repo: z.string(), pointer: strict({ kind: z.enum(POINTER_KINDS), number: z.number().int(), url: z.string() }), source: z.string(), by: z.string() }),
  'pointed_job.status_changed': strict({ id: z.string(), from: pointedJobStatus, to: pointedJobStatus, lane: z.string().optional(), by: z.string() }),
  // Direct jobs (issue #901, src/direct-jobs/): who submitted one and what they authorized; never its title or brief.
  'direct_job.submitted': strict({ id: z.string(), by: z.string(), via: z.enum(ACTION_VIAS), labels: z.array(z.string()), authorizations: z.array(z.string()), repo: z.string().optional(), pushRequirements: z.array(z.string()).optional() }),
  'direct_job.promoted': strict({ id: z.string(), repo: z.string(), kind: z.enum(['issue', 'comment']), number: z.number().int(), url: z.string(), by: z.string(), artifacts: z.number().int(), update: z.boolean() }),
  'direct_job.promotion_revoked': strict({ id: z.string(), repo: z.string(), kind: z.enum(['issue', 'comment']), number: z.number().int(), by: z.string() }),
  'direct_query.accepted': strict({ id: z.string(), requestId: z.string(), by: z.string(), via: z.enum(ACTION_VIAS), callback: z.string().optional() }), 'direct_query.answered': strict({ id: z.string(), requestId: z.string(), jobId: z.string(), answer: z.unknown(), artifacts: z.array(strict({ id: z.string(), title: z.string(), url: z.string() })), url: z.string(), callback: z.string().optional() }),
  'direct_query.failed': strict({ id: z.string(), requestId: z.string(), jobId: z.string(), error: z.string(), url: z.string(), callback: z.string().optional() }), 'direct_query.cancelled': strict({ id: z.string(), requestId: z.string(), jobId: z.string(), url: z.string(), callback: z.string().optional() }),
  'direct_query.question_asked': strict({ id: z.string(), requestId: z.string(), jobId: z.string(), questionId: z.string(), question: z.string(), answerUrl: z.string(), url: z.string(), callback: z.string().optional() }),
};

// GitHub watches (issue #427, src/github-watch/): what changed on a watched item at one poll, and the interval changed.
const watchState = z.enum(['open', 'closed', 'merged']);
const watchComment = strict({ id: z.number().int(), author: z.string(), at: z.string() });
const watchSetChange = strict({ added: z.array(z.string()), removed: z.array(z.string()) });
const watchChanges = strict({
  state: strict({ from: watchState, to: watchState, reason: z.string().optional(), mergedAt: z.string().optional() }).optional(),
  labels: watchSetChange.optional(),
  comments: strict({ added: z.array(watchComment), removed: z.number().int().min(0) }).optional(),
  reviews: strict({ added: z.array(watchComment.extend({ state: z.string() })) }).optional(),
  linkedPullRequests: watchSetChange.optional(),
});
const watchSettings = strict({ intervalSeconds: z.number().int().min(1) });
export const githubWatchEvents = {
  'github_watch.changed': strict({ pointedJob: z.string(), repo: z.string(), pointer: strict({ kind: z.enum(POINTER_KINDS), number: z.number().int(), url: z.string() }), changes: watchChanges }),
  'github_watch.settings_changed': strict({ from: watchSettings, to: watchSettings, by: z.string() }),
};

const driftAt = { watcher: z.string(), kind: z.string() };
const driftIssueAt = strict({ ...driftAt, number: z.number().int(), url: z.string() });
const componentWatcherSettings = strict({ fileIssues: z.boolean() });
export const driftEvents = {
  'drift.found': strict({ ...driftAt, items: z.number().int().min(1) }),
  'drift.cleared': strict(driftAt),
  'drift.issue_filed': driftIssueAt,
  'drift.issue_updated': driftIssueAt,
  'component_watchers.settings_changed': strict({ from: componentWatcherSettings, to: componentWatcherSettings, by: z.string() }),
};

/** A job's task count (issue #794): done of total, 0 ≤ done ≤ total, total ≥ 1. */
// A terraform workspace need's state backend on `template.saved` (issue #715).
export const stateBackend = strict({ bucket: z.string(), region: z.string(), keyPrefix: z.string().optional() });

export const taskCount = strict({ done: z.number().int().min(0), total: z.number().int().min(1) })
  .refine((t) => t.done <= t.total, { message: 'done must not exceed total' });

/** One hold on a level's answer (issue #679, `AnswerHold`). */
export const answerHold = strict({
  reason: z.enum(['guard', 'high_priority', 'auto_answer_off', 'low_confidence']), by: z.enum(['risk', 'guard']).optional(),
  guards: z.array(z.string()).optional(), confidence: z.enum(CONFIDENCES).optional(), threshold: z.enum(CONFIDENCES).optional(),
  // The Decider's risk hold (issue #679, `DeciderRiskHold`).
  decider: strict({
    risk: z.enum(RISK_LEVELS).optional(), categories: z.array(z.enum(RISK_CATEGORIES)).optional(), confidence: z.number().min(0).max(1).optional(),
    threshold: z.number().min(0).max(1), error: z.string().optional(),
  }).optional(),
});
