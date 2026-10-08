// The UI session's webhook subscription and notifier mutations. Issue #18: one webhook subscription
// added, edited or removed (a row, issue #78); no secret passes either way (issue #56): the runtime
// holds them. Issue #378: Send test event on a subscription or a notifier, and Send open questions on
// a notifier — each sends now and answers what the receiver said; nothing is stored and nothing is
// appended to the event log. Least role: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';
import { webhooksView } from '../webhooks.ts';

// The content (url, events) is checked in the editor, so the UI shows one set of messages; here only
// the shape. No secret (issue #56), no secretFile, no new name; secretEnv only on add, and only a
// WEBHOOK_SECRET_* variable (checked in the editor).
const webhookFields = { name: z.string().min(1) };
export const webhooksEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), ...webhookFields, url: z.string(), events: z.array(z.string()), secretEnv: z.string(), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('edit'), ...webhookFields, url: z.string().optional(), events: z.array(z.string()).optional(), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('remove'), ...webhookFields }),
]);
export const webhookTestBody = z.strictObject({ name: z.string().min(1) });
export const notifierActionBody = z.strictObject({ action: z.enum(['test', 'send-open']), name: z.string().min(1) });

const STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;

export function registerWebhookAndNotifierRoutes(app: FastifyInstance, o: {
  admin: { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
  tenant: (req: FastifyRequest) => TenantParts;
}): void {
  // Answers the new GET /api/webhooks view.
  app.post('/ui/api/webhooks', o.admin, async (req) => {
    const t = o.tenant(req);
    const r = t.webhooksEditor.edit(parseWith(webhooksEditBody, req.body));
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return webhooksView(t.store, t.secretProblem);
  });

  // One signed `webhook.test` event to the subscription, one attempt.
  app.post('/ui/api/webhooks/test', o.admin, async (req) => {
    const { name } = parseWith(webhookTestBody, req.body);
    const r = await o.tenant(req).dispatcher.test(name);
    if (!r) throw new HttpError(404, `no webhook subscription ${name}`);
    return r;
  });

  // A running notifier's action: `test` (one marked payload, one attempt) or `send-open`.
  app.post('/ui/api/notifiers', o.admin, async (req) => {
    const { action, name } = parseWith(notifierActionBody, req.body);
    const r = await o.tenant(req).plugins.notifierAction(name, action);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return r.result;
  });
}
