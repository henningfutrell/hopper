import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../domain/ports.ts';
import { EVENT_TYPES } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';

const httpUrl = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'url must be an http(s) URL');

const createBody = z.object({
  url: httpUrl,
  events: z.array(z.string().refine((e) => e === '*' || (EVENT_TYPES as readonly string[]).includes(e), {
    message: 'unknown event type',
  })).min(1).default(['*']),
  secret: z.string().min(1).optional(),
});

const deliveriesQuery = z.object({
  subscriptionId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export function webhookRoutes(app: FastifyInstance, o: { store: Store }): void {
  const { webhooks } = o.store;

  // The secret is returned here once and never listed again.
  app.post('/api/webhooks', async (req, reply) => {
    const b = parseWith(createBody, req.body);
    const sub = webhooks.create({ url: b.url, events: b.events, secret: b.secret ?? randomBytes(32).toString('hex') });
    return reply.code(201).send(sub);
  });

  app.get('/api/webhooks', async () => ({
    subscriptions: webhooks.list().map(({ secret: _secret, ...rest }) => rest),
  }));

  app.delete('/api/webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!webhooks.delete(id)) throw new HttpError(404, `webhook subscription ${id} not found`);
    return reply.code(204).send();
  });

  app.get('/api/webhooks/deliveries', async (req) => {
    const q = parseWith(deliveriesQuery, req.query);
    return { deliveries: webhooks.listDeliveries({ ...(q.subscriptionId ? { subscriptionId: q.subscriptionId } : {}), limit: q.limit }) };
  });
}
