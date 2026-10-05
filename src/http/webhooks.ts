// Webhook subscriptions are rows in the store (issue #78), which the UI session may edit
// (POST /ui/api/webhooks, src/http/ui/): these routes only read — the subscriptions (each with the
// variable its secret is in and whether the runtime gives it; never a secret), the deliveries.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import { parseWith } from './errors.ts';

/** Why the runtime gives no secret in `secretEnv`, or undefined when it does. Never the secret. */
export type SecretProblem = (secretEnv: string) => string | undefined;

export const deliveriesQuery = z.object({
  subscriptionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/** GET /api/webhooks: every subscription, with why the runtime gives no secret for it (if so). */
export function webhooksView(store: Pick<Store, 'webhooks'>, secretProblem: SecretProblem) {
  return {
    subscriptions: store.webhooks.list().map((sub) => {
      const problem = secretProblem(sub.secretEnv);
      return problem === undefined ? sub : { ...sub, secretProblem: problem };
    }),
  };
}

export function webhookRoutes(app: FastifyInstance, o: { store: Store; secretProblem: SecretProblem }): void {
  const { webhooks } = o.store;

  app.get('/api/webhooks', async () => webhooksView(o.store, o.secretProblem));

  app.get('/api/webhooks/deliveries', async (req) => {
    const q = parseWith(deliveriesQuery, req.query);
    return { deliveries: webhooks.listDeliveries({ ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}), limit: q.limit }) };
  });
}
