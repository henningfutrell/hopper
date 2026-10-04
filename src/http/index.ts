// The HTTP edge: read-only routes, SSE, the static UI, and the UI session — the only way to
// mutate (design.md "Phase 3"). Loopback only; every request passes the Host guard (AGENTS.md).
import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock, PluginsView, QuestionService, SourceRegistry, Store, WebhookDispatcher } from '../domain/ports.ts';
import type { Engine } from '../engine/index.ts';
import type { WebhookConfigStatus } from '../webhooks/config.ts';
import { installErrorHandling } from './errors.ts';
import { installHostGuard } from './host-guard.ts';
import { jobRoutes } from './jobs.ts';
import { questionRoutes } from './questions.ts';
import { sourceRoutes } from './sources.ts';
import { sseRoutes } from './sse.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { registerUiRoutes } from './ui/index.ts';
import { webhookRoutes } from './webhooks.ts';

export interface ServerOptions {
  engine: Engine;
  store: Store;
  dispatcher: WebhookDispatcher;
  questions: QuestionService;
  sources: SourceRegistry;
  /** The router's status and GET /api/plugins. */
  plugins: PluginsView;
  webhookConfig: { status(): WebhookConfigStatus };
  clock: Clock;
  version: string;
  /** The bound port, for the Host guard and the UI Origin check (known only after listen). */
  port: () => number;
  /** Where the UI login code file lives. */
  dataDir: string;
  sessionHours: number;
  /** Fastify logger; off by default. */
  logger?: boolean;
}

export function createServer(o: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, forceCloseConnections: true });
  installErrorHandling(app);
  installHostGuard(app, o.port);
  jobRoutes(app, o);
  stateRoutes(app, o);
  questionRoutes(app, o);
  webhookRoutes(app, o);
  sourceRoutes(app, o);
  sseRoutes(app, o);
  staticRoutes(app);
  registerUiRoutes(app, { engine: o.engine, questions: o.questions, uiSessions: o.store.uiSessions, plugins: o.plugins, port: o.port, dataDir: o.dataDir, clock: o.clock, sessionHours: o.sessionHours });
  return app;
}
