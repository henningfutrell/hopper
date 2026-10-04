// The HTTP edge: read-only routes, SSE, the static UI, and the UI session — the only way to
// mutate (design.md "Phase 3"). Loopback, plus the LAN names when set; every request passes the
// Host guard (AGENTS.md).
import Fastify, { type FastifyInstance } from 'fastify';
import type { Clock, PluginsView, QuestionService, SourceRegistry, Store, WebhookDispatcher } from '../domain/ports.ts';
import type { Engine } from '../engine/index.ts';
import type { WebhookConfigView } from './webhooks.ts';
import type { WebhooksEditor } from '../webhooks/edit.ts';
import { accountRoutes } from './accounts.ts';
import { installErrorHandling } from './errors.ts';
import { installHostGuard } from './host-guard.ts';
import type { Lan } from './reach.ts';
import { jobRoutes } from './jobs.ts';
import { questionGatesRoutes } from './question-gates.ts';
import { questionRoutes } from './questions.ts';
import { sourceRoutes } from './sources.ts';
import { sseRoutes } from './sse.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { registerUiRoutes } from './ui/index.ts';
import { createUiSessions } from './ui/sessions.ts';
import { webhookRoutes } from './webhooks.ts';

export interface ServerOptions {
  engine: Engine;
  store: Store;
  dispatcher: WebhookDispatcher;
  questions: QuestionService;
  sources: SourceRegistry;
  /** The router's status and GET /api/plugins. */
  plugins: PluginsView;
  webhookConfig: WebhookConfigView;
  /** UI edits of webhooks.yaml (POST /ui/api/webhooks). */
  webhooksEditor: WebhooksEditor;
  clock: Clock;
  version: string;
  /** The bound port, for the Host guard and the UI Origin check (known only after listen). */
  port: () => number;
  /** The rules file (JOB_HOPPER_RULES_FILE): read by GET /api/question-gates, written by POST /ui/api/rules-file. */
  rulesFile: string;
  /** Where the UI login code file lives. */
  dataDir: string;
  sessionHours: number;
  /** The LAN names and peers (design.md "Reaching the UI across the LAN"); empty: loopback only. */
  lan: Lan;
  /** The built UI bundle (ui/dist). */
  uiDir: string;
  /** Fastify logger; off by default. */
  logger?: boolean;
}

export function createServer(o: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, forceCloseConnections: true });
  installErrorHandling(app);
  const sessions = createUiSessions({ repo: o.store.uiSessions, clock: o.clock, hours: o.sessionHours });
  installHostGuard(app, { port: o.port, lan: o.lan, sessions });
  jobRoutes(app, o);
  stateRoutes(app, o);
  questionRoutes(app, o);
  questionGatesRoutes(app, o);
  webhookRoutes(app, o);
  sourceRoutes(app, o);
  accountRoutes(app, o);
  sseRoutes(app, o);
  staticRoutes(app, o.uiDir);
  registerUiRoutes(app, {
    engine: o.engine, questions: o.questions, sessions, plugins: o.plugins, rulesFile: o.rulesFile, port: o.port, lan: o.lan, dataDir: o.dataDir,
    store: o.store, webhookConfig: o.webhookConfig, webhooksEditor: o.webhooksEditor,
  });
  return app;
}
