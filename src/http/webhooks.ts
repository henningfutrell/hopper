// Webhook subscriptions come from webhooks.yaml (src/webhooks/config.ts), never from the API:
// these routes only read — the subscriptions (secrets omitted), the file's status, the deliveries.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import type { WebhookConfigStatus } from '../webhooks/config.ts';
import { parseWith } from './errors.ts';

const deliveriesQuery = z.object({
  subscriptionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export function webhookRoutes(app: FastifyInstance, o: { store: Store; webhookConfig: { status(): WebhookConfigStatus } }): void {
  const { webhooks } = o.store;

  app.get('/api/webhooks', async () => ({
    subscriptions: webhooks.list().map(({ secret: _secret, ...rest }) => rest),
    config: o.webhookConfig.status(),
  }));

  app.get('/api/webhooks/deliveries', async (req) => {
    const q = parseWith(deliveriesQuery, req.query);
    return { deliveries: webhooks.listDeliveries({ ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}), limit: q.limit }) };
  });
}
