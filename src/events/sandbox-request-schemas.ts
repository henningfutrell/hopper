// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): the two toggles, and each sandbox request from
// its ask to its box or its end, on the job's timeline. Issue #1001: the auto-approve policy with the toggles, and the
// template's blast radius when the policy approved a run; the time limit of remembered write approvals, and one forgotten. Issue #2206: an action grant asked, granted, declined and revoked. Issue #655 part 8: sandbox strictness (brake 2) changed. Issue #2146: a bastion's start and end, its relay connections and its reads. Issue #2231: database reads. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';
import { ASSET_KINDS } from '../domain/access.ts';
import { SANDBOX_STRICTNESS } from '../domain/sandbox-strictness.ts';

const strict = z.strictObject;
const level = z.enum(['low', 'medium', 'high']);
const brake = z.enum(SANDBOX_STRICTNESS);
/** An action grant's scope (issue #2206): the aws-role (`<account>/<role>`), the AWS action and its resource's ARN. */
const action = { role: z.string(), action: z.string(), resource: z.string() };
/** A database read's asset (issue #2231): `database/<name>`. */
const dbAsset = strict({ kind: z.enum(ASSET_KINDS), name: z.string() });
const STRICTNESS = strict({ default: brake, radius: strict({ low: brake.optional(), medium: brake.optional(), high: brake.optional() }), templates: z.record(z.string(), brake) });

export const SANDBOX_REQUEST_EVENT_SCHEMAS = {
  'vault.sandbox_approvals_set': strict({
    skipTemplateApproval: z.boolean(), skipSandboxApproval: z.boolean(),
    autoApprove: strict({ low: z.boolean(), medium: z.boolean(), high: z.boolean() }).optional(),
    rememberWritesHours: z.number().int().min(0).optional(), standingReadGrant: z.boolean().optional(), by: z.string(),
  }),
  'sandbox.strictness_changed': strict({ from: STRICTNESS, to: STRICTNESS, by: z.string() }),
  'vault.sandbox_requested': strict({ request: z.string(), template: z.string() }),
  // Issue #2197 part 2: a new run card, one per job and template; the notifiers send it.
  'vault.run_card_opened': strict({ template: z.string(), waits: strict({ template: z.boolean(), run: z.boolean() }), purpose: z.string().optional() }),
  'vault.sandbox_approved': strict({ request: z.string(), template: z.string(), by: z.string(), radius: level.optional() }),
  'vault.sandbox_declined': strict({ request: z.string(), template: z.string(), reason: z.string(), by: z.string() }),
  'vault.sandbox_started': strict({ request: z.string(), template: z.string(), container: z.string() }),
  'vault.sandbox_failed': strict({ request: z.string(), template: z.string(), reason: z.string() }),
  'vault.write_forgotten': strict({ operation: z.enum(['write', 'sync', 'apply', 'observe']), asset: strict({ kind: z.enum(ASSET_KINDS), name: z.string() }), by: z.string() }),
  'vault.action_asked': strict({ job: z.string(), ...action, why: z.string().optional() }),
  'vault.action_granted': strict({ job: z.string().optional(), ...action, by: z.string() }),
  'vault.action_declined': strict({ job: z.string(), ...action, reason: z.string().optional(), by: z.string() }),
  'vault.action_revoked': strict({ ...action, by: z.string() }),
  // Issue #2146: a bastion started for a job, and its end.
  'bastion.started': strict({ bastion: z.string(), template: z.string(), box: z.string(), targets: z.array(z.string()), secrets: z.array(z.string()).optional(), expiresAt: z.string() }),
  'bastion.ended': strict({ bastion: z.string(), template: z.string(), box: z.string(), reason: z.enum(['stopped', 'expired', 'job-ended', 'failed']), by: z.string().optional(), problem: z.string().optional() }), 'bastion.relayed': strict({ bastion: z.string(), target: z.string(), openedAt: z.string(), ms: z.number().int().nonnegative() }), 'bastion.relay_refused': strict({ bastion: z.string(), target: z.string(), reason: z.string() }), 'bastion.read': strict({ bastion: z.string(), target: z.string(), method: z.enum(['GET', 'POST']), path: z.string(), status: z.number().int().optional(), bytes: z.number().int().nonnegative().optional(), problem: z.string().optional(), ms: z.number().int().nonnegative() }),
  // Issue #2231: a database read's role minted and dropped, the read, and a read refused. Never a password or a row.
  'database.role_minted': strict({ job: z.string(), read: z.string(), template: z.string(), asset: dbAsset, credential: z.string(), role: z.string(), decision: z.string(), expiresAt: z.string() }),
  'database.role_dropped': strict({ job: z.string().optional(), read: z.string().optional(), asset: dbAsset, credential: z.string(), role: z.string(), reason: z.enum(['read-ended', 'expired']) }),
  'database.read': strict({ job: z.string(), read: z.string(), template: z.string(), asset: dbAsset, role: z.string(), decision: z.string(), sql: z.string(), rows: z.number().int().nonnegative().optional(), bytes: z.number().int().nonnegative().optional(), problem: z.string().optional(), ms: z.number().int().nonnegative() }),
  'database.read_refused': strict({ job: z.string(), template: z.string(), asset: dbAsset, reason: z.string(), decision: z.string().optional() }),
};
