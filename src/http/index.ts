// The HTTP edge: Fastify routes, SSE, the static UI. Loopback only; no auth (AGENTS.md).
import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock, Store, WebhookDispatcher } from '../domain/ports.ts';
import type { Engine } from '../engine/index.ts';
import { installErrorHandling } from './errors.ts';
import { jobRoutes } from './jobs.ts';
import { sseRoutes } from './sse.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { webhookRoutes } from './webhooks.ts';

export interface ServerOptions {
  engine: Engine;
  store: Store;
  dispatcher: WebhookDispatcher;
  clock: Clock;
  version: string;
  /** Fastify logger; off by default. */
  logger?: boolean;
}

export function createServer(o: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, forceCloseConnections: true });
  installErrorHandling(app);
  jobRoutes(app, o);
  stateRoutes(app, o);
  webhookRoutes(app, o);
  sseRoutes(app, o);
  staticRoutes(app);
  return app;
}
