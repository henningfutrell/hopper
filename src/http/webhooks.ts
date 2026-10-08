// Webhook subscriptions are rows in the store (issue #78), which the UI session may edit
// (POST /ui/api/webhooks, src/http/ui/): these routes only read — the subscriptions (each with when its
// stored secret last changed, or the runtime variable one from before names, and why it has no secret to
// sign with, if so; never a secret, issue #451), the deliveries.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserStore } from '../domain/ports.ts';
import type { WebhookSubscription } from '../domain/types.ts';
import { parseWith } from './errors.ts';
import type { TenantParts } from './tenants.ts';

/** Why the subscription has no secret to sign with (src/webhooks/secrets.ts), or undefined. Never the secret. */
export type SecretProblem = (sub: WebhookSubscription) => string | undefined;

export const deliveriesQuery = z.object({
  subscriptionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/** GET /api/webhooks: every subscription, with why it has no secret to sign with (if so). */
export function webhooksView(store: Pick<UserStore, 'webhooks'>, secretProblem: SecretProblem) {
  return {
    subscriptions: store.webhooks.list().map((sub) => {
      const problem = secretProblem(sub);
      return problem === undefined ? sub : { ...sub, secretProblem: problem };
    }),
  };
}

export function webhookRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/webhooks', async (req) => { const t = o.tenant(req); return webhooksView(t.store, t.secretProblem); });

  app.get('/api/webhooks/deliveries', async (req) => {
    const q = parseWith(deliveriesQuery, req.query);
    return { deliveries: o.tenant(req).store.webhooks.listDeliveries({ ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}), limit: q.limit }) };
  });
}
