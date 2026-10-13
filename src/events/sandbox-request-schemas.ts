// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): the two toggles, and each sandbox request from
// its ask to its box or its end, on the job's timeline. Issue #1001: the auto-approve policy with the toggles, and the
// template's blast radius when the policy approved a run. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const strict = z.strictObject;
const level = z.enum(['low', 'medium', 'high']);

export const SANDBOX_REQUEST_EVENT_SCHEMAS = {
  'vault.sandbox_approvals_set': strict({
    skipTemplateApproval: z.boolean(), skipSandboxApproval: z.boolean(),
    autoApprove: strict({ low: z.boolean(), medium: z.boolean(), high: z.boolean() }).optional(), by: z.string(),
  }),
  'vault.sandbox_requested': strict({ request: z.string(), template: z.string() }),
  'vault.sandbox_approved': strict({ request: z.string(), template: z.string(), by: z.string(), radius: level.optional() }),
  'vault.sandbox_declined': strict({ request: z.string(), template: z.string(), reason: z.string(), by: z.string() }),
  'vault.sandbox_started': strict({ request: z.string(), template: z.string(), container: z.string() }),
  'vault.sandbox_failed': strict({ request: z.string(), template: z.string(), reason: z.string() }),
};
