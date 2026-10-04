// Webhook subscriptions come from webhooks.yaml (src/webhooks/config.ts), which the UI session may
// edit (POST /ui/api/webhooks, src/http/ui/): these routes only read — the subscriptions (secrets
// omitted), the file's status and version, the deliveries.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import type { SecretSource, WebhookConfigStatus } from '../webhooks/config.ts';

/** What the webhooks routes read of the webhooks.yaml watcher. */
export interface WebhookConfigView { status(): WebhookConfigStatus; secretSources(): Record<string, SecretSource> }
import { parseWith } from './errors.ts';

const deliveriesQuery = z.object({
  subscriptionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

/** GET /api/webhooks: every subscription without its secret (but where it lives), and the file's status. */
export function webhooksView(store: Pick<Store, 'webhooks'>, config: WebhookConfigView) {
  const sources = config.secretSources();
  return {
    subscriptions: store.webhooks.list().map(({ secret: _secret, ...rest }) => ({ ...rest, secretSource: sources[rest.name] ?? 'inline' })),
    config: config.status(),
  };
}

export function webhookRoutes(app: FastifyInstance, o: { store: Store; webhookConfig: WebhookConfigView }): void {
  const { webhooks } = o.store;

  app.get('/api/webhooks', async () => webhooksView(o.store, o.webhookConfig));

  app.get('/api/webhooks/deliveries', async (req) => {
    const q = parseWith(deliveriesQuery, req.query);
    return { deliveries: webhooks.listDeliveries({ ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}), limit: q.limit }) };
  });
}
