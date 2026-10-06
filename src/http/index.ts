// The HTTP edge: read-only routes, SSE, the static UI, the API reference, and the UI session — the
// only way to mutate (design.md "Phase 3"). Loopback, plus the LAN names when set; every request
// passes the Host guard (AGENTS.md).
import Fastify, { type FastifyInstance } from 'fastify';
import { apiReferenceRoutes } from './api-reference.ts';
import type { SignIn } from '../auth/index.ts';
import type { Clock, InstanceStore, PluginStoreView, Updater } from '../domain/ports.ts';
import { accountRoutes } from './accounts.ts';
import { installErrorHandling } from './errors.ts';
import { ghLoginRoutes } from './gh-login.ts';
import { installHostGuard } from './host-guard.ts';
import type { Lan } from './reach.ts';
import { jobRoutes } from './jobs.ts';
import { pluginStoreRoutes } from './plugin-store.ts';
import { questionGatesRoutes } from './question-gates.ts';
import { questionRoutes } from './questions.ts';
import { createRealmsAdmin, realmRoutes } from './realms.ts';
import { sourceRoutes } from './sources.ts';
import { sseRoutes } from './sse.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { installTenancy, tenantOf, type Tenants } from './tenants.ts';
import { registerUiRoutes } from './ui/index.ts';
import { createUiSessions } from './ui/sessions.ts';
import { updateRoutes } from './update.ts';
import { userRoutes } from './users.ts';
import { webhookRoutes } from './webhooks.ts';

export type { TenantParts, Tenants } from './tenants.ts';

export interface ServerOptions {
  /** The instance store: UI sessions, login codes, the users, auth.yaml. */
  instance: Pick<InstanceStore, 'uiSessions' | 'loginCodes' | 'users' | 'documents'>;
  /** Every user's running parts (issue #158): a tenant route reads and changes the request's user's. */
  tenants: Tenants;
  /** The plugin store (the instance's): GET /api/plugin-store, POST /ui/api/plugin-store. */
  pluginStore: PluginStoreView;
  /** Self-update (the instance's): GET /api/update, POST /ui/api/update. */
  updater: Updater;
  clock: Clock;
  version: string;
  /** The bound port, for the Host guard and the UI Origin check (known only after listen). */
  port: () => number;
  sessionHours: number;
  /** auth.yaml as it applies: local sign-in, no sign-in and the realms. */
  signIn: SignIn;
  /** The instance's own secrets (a realm's clientSecretEnv, bindPasswordEnv): read when auth.yaml changes in the UI. */
  secret: (name: string) => string | undefined;
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
  const sessions = createUiSessions({ repo: o.instance.uiSessions, clock: o.clock, hours: o.sessionHours });
  // auth.yaml may have changed since the sessions were made: a realm removed or off, or a rule, ends them.
  const r = sessions.reconcile(o.signIn.roleOf);
  if (r.dropped + r.changed > 0) console.warn(`hopper: auth.yaml applied to stored UI sessions: ${r.dropped} ended, ${r.changed} changed role`);
  installHostGuard(app, { port: o.port, lan: o.lan, sessions });
  installTenancy(app, { tenants: o.tenants, sessions, port: o.port, lan: o.lan });
  const tenant = { tenant: (req: Parameters<typeof tenantOf>[1]) => tenantOf(o.tenants, req) };
  apiReferenceRoutes(app, o.version);
  jobRoutes(app, tenant);
  stateRoutes(app, { ...tenant, clock: o.clock, version: o.version });
  questionRoutes(app, tenant);
  questionGatesRoutes(app, tenant);
  webhookRoutes(app, tenant);
  sourceRoutes(app, tenant);
  accountRoutes(app, tenant);
  ghLoginRoutes(app, tenant);
  sseRoutes(app, tenant);
  updateRoutes(app, o);
  pluginStoreRoutes(app, o);
  userRoutes(app, { tenants: o.tenants, sessions });
  const realms = createRealmsAdmin({ documents: o.instance.documents, secret: o.secret, signIn: o.signIn, sessions });
  realmRoutes(app, { realms, sessions });
  staticRoutes(app, o.uiDir);
  registerUiRoutes(app, {
    ...tenant, tenants: o.tenants, instance: o.instance, sessions, signIn: o.signIn, realms, pluginStore: o.pluginStore, port: o.port, lan: o.lan, clock: o.clock,
    updater: o.updater,
  });
  return app;
}
