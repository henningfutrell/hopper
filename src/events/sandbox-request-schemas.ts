// Sandboxes jobs start (issue #991, design.md "Sandboxes jobs start"): the two toggles, and each sandbox request from
// its ask to its box or its end, on the job's timeline. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';

const strict = z.strictObject;

export const SANDBOX_REQUEST_EVENT_SCHEMAS = {
  'vault.sandbox_approvals_set': strict({ skipTemplateApproval: z.boolean(), skipSandboxApproval: z.boolean(), by: z.string() }),
  'vault.sandbox_requested': strict({ request: z.string(), template: z.string() }),
  'vault.sandbox_approved': strict({ request: z.string(), template: z.string(), by: z.string() }),
  'vault.sandbox_declined': strict({ request: z.string(), template: z.string(), reason: z.string(), by: z.string() }),
  'vault.sandbox_started': strict({ request: z.string(), template: z.string(), container: z.string() }),
  'vault.sandbox_failed': strict({ request: z.string(), template: z.string(), reason: z.string() }),
};
