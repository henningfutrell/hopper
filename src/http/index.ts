// The HTTP edge: read-only routes, SSE, the static UI, the API reference, and the UI session — the
// only way to mutate (design.md "Phase 3"). Loopback, plus the LAN names when set; every request
// passes the Host guard (AGENTS.md).
import Fastify, { type FastifyInstance } from 'fastify';
import { apiReferenceRoutes } from './api-reference.ts';
import type { SignIn } from '../auth/index.ts';
import type { Clock, PluginStoreView, PluginsView, QuestionService, SourceRegistry, Store, Updater, WebhookDispatcher } from '../domain/ports.ts';
import type { Engine } from '../engine/index.ts';
import type { WebhookConfigView } from './webhooks.ts';
import type { WebhooksEditor } from '../webhooks/edit.ts';
import { accountRoutes } from './accounts.ts';
import { installErrorHandling } from './errors.ts';
import { installHostGuard } from './host-guard.ts';
import type { Lan } from './reach.ts';
import { jobRoutes } from './jobs.ts';
import { pluginStoreRoutes } from './plugin-store.ts';
import { questionGatesRoutes } from './question-gates.ts';
import { questionRoutes } from './questions.ts';
import { sourceRoutes } from './sources.ts';
import { sseRoutes } from './sse.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { registerUiRoutes } from './ui/index.ts';
import { createUiSessions } from './ui/sessions.ts';
import { updateRoutes } from './update.ts';
import { webhookRoutes } from './webhooks.ts';

export interface ServerOptions {
  engine: Engine;
  store: Store;
  dispatcher: WebhookDispatcher;
  questions: QuestionService;
  sources: SourceRegistry;
  /** The router's status and GET /api/plugins. */
  plugins: PluginsView;
  /** The plugin store: GET /api/plugin-store, POST /ui/api/plugin-store. */
  pluginStore: PluginStoreView;
  webhookConfig: WebhookConfigView;
  /** UI edits of webhooks.yaml (POST /ui/api/webhooks). */
  webhooksEditor: WebhooksEditor;
  /** Self-update: GET /api/update, POST /ui/api/update. */
  updater: Updater;
  clock: Clock;
  version: string;
  /** The bound port, for the Host guard and the UI Origin check (known only after listen). */
  port: () => number;
  sessionHours: number;
  /** auth.yaml as loaded: local sign-in and the identity providers. */
  signIn: SignIn;
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
  // auth.yaml may have changed since the sessions were made: a removed provider or rule ends them.
  const r = sessions.reconcile(o.signIn.roleOf);
  if (r.dropped + r.changed > 0) console.warn(`hopper: auth.yaml applied to stored UI sessions: ${r.dropped} ended, ${r.changed} changed role`);
  installHostGuard(app, { port: o.port, lan: o.lan, sessions });
  apiReferenceRoutes(app, o.version);
  jobRoutes(app, o);
  stateRoutes(app, o);
  questionRoutes(app, o);
  questionGatesRoutes(app, { documents: o.store.documents });
  webhookRoutes(app, o);
  sourceRoutes(app, o);
  accountRoutes(app, o);
  updateRoutes(app, o);
  pluginStoreRoutes(app, o);
  sseRoutes(app, o);
  staticRoutes(app, o.uiDir);
  registerUiRoutes(app, {
    engine: o.engine, questions: o.questions, sessions, signIn: o.signIn, plugins: o.plugins, pluginStore: o.pluginStore, port: o.port, lan: o.lan, clock: o.clock,
    store: o.store, webhookConfig: o.webhookConfig, webhooksEditor: o.webhooksEditor, updater: o.updater,
  });
  return app;
}
