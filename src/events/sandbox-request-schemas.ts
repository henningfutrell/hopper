// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): the two toggles, and each sandbox request from
// its ask to its box or its end, on the job's timeline. Issue #1001: the auto-approve policy with the toggles, and the
// template's blast radius when the policy approved a run; the time limit of remembered write approvals, and one forgotten. Issue #2206: an action grant asked, granted, declined and revoked. Issue #655 part 8: sandbox strictness (brake 2) changed. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';
import { ASSET_KINDS } from '../domain/access.ts';
import { SANDBOX_STRICTNESS } from '../domain/sandbox-strictness.ts';

const strict = z.strictObject;
const level = z.enum(['low', 'medium', 'high']);
const brake = z.enum(SANDBOX_STRICTNESS);
/** An action grant's scope (issue #2206): the aws-role (`<account>/<role>`), the AWS action and its resource's ARN. */
const action = { role: z.string(), action: z.string(), resource: z.string() };
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
};
