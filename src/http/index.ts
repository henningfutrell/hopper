// The HTTP edge: read-only routes, SSE, the static UI, the API reference, and the UI session — the
// only way to mutate (design.md "Phase 3"). Loopback, plus the LAN names when set; every request
// passes the Host guard (AGENTS.md).
import Fastify, { type FastifyInstance } from 'fastify';
import { accessRoutes } from './access.ts';
import { apiReferenceRoutes } from './api-reference.ts';
import type { Access } from '../authz/service.ts';
import { clientLinkRoutes, type ClientLinkOptions } from './client-link.ts';
import type { SignIn } from '../auth/index.ts';
import type { Clock, InstanceStore, PluginStoreView, Updater } from '../domain/ports.ts';
import { accountRoutes } from './accounts.ts';
import { installErrorHandling } from './errors.ts';
import { connectedAccountsRoutes } from './connected-accounts.ts';
import { installHostGuard } from './host-guard.ts';
import type { Lan } from './reach.ts';
import { jobRoutes } from './jobs.ts';
import { jobGitHubRoutes } from './job-github.ts';
import { jobSkillRoutes } from './job-skill.ts';
import { pluginStoreRoutes } from './plugin-store.ts';
import { jobRulesRoutes } from './job-rules.ts';
import { questionGatesRoutes } from './question-gates.ts';
import { failureRoutes } from './failures.ts';
import { minorDecisionRoutes } from './minor-decisions.ts';
import { loginRoutes } from './logins.ts';
import { reviewRoutes } from './reviews.ts';
import { sectionRoutes } from './sections.ts';
import { questionRoutes } from './questions.ts';
import { createRealmsAdmin, realmRoutes } from './realms.ts';
import { sourceRoutes } from './sources.ts';
import { sseRoutes } from './sse.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { installTenancy, tenantOf, type Tenants } from './tenants.ts';
import { registerUiRoutes } from './ui/index.ts';
import type { Sandboxes } from '../sandboxes/service.ts';
import { createUiSessions, identityName } from './ui/sessions.ts';
import { updateRoutes } from './update.ts';
import { instanceRoutes } from './instance.ts';
import { usageHistoryRoutes } from './usage-history.ts';
import { machineHistoryRoutes } from './machine-history.ts';
import { userRoutes } from './users.ts';
import { createInstanceAdmin } from './instance-admin.ts';
import { vaultRoutes } from './vault.ts';
import { webhookRoutes } from './webhooks.ts';

export type { TenantParts, Tenants } from './tenants.ts';

export interface ServerOptions {
  /** The instance store: UI sessions, login codes, the users and their identity links, the sign-in config. */
  instance: Pick<InstanceStore, 'uiSessions' | 'loginCodes' | 'joinCodes' | 'users' | 'identities' | 'signInConfig' | 'settings' | 'tx'>;
  /** Every user's running parts (issue #158): a tenant route reads and changes the request's user's. */
  tenants: Tenants;
  /** The plugin store (the instance's): GET /api/plugin-store, POST /ui/api/plugin-store. */
  pluginStore: PluginStoreView;
  /** Self-update (the instance's): GET /api/update, POST /ui/api/update. */
  updater: Updater;
  /** Access (issue #559, the instance's): GET /api/access, POST /ui/api/access. */
  access: Access;
  /** The sandbox boxes the hopper starts (issue #603): GET /api/sandboxes, POST /ui/api/machines/sandbox. */
  sandboxes: Sandboxes;
  clock: Clock;
  version: string;
  /** The bound port, for the Host guard and the UI Origin check (known only after listen). */
  port: () => number;
  /** The sign-in config as it applies: local sign-in, no sign-in and the realms. */
  signIn: SignIn;
  /** The realms HOPPER_SIGN_IN_* variables set up (issue #216): Settings → Sign-in says so. */
  signInEnvironment: string[];
  /** The LAN names and peers (design.md "Reaching the UI across the LAN"); empty: loopback only. */
  lan: Lan;
  /** The built UI bundle (ui/dist). */
  uiDir: string;
  /** Machines joining and dialling in (issue #308): their links, the client release, the install script. */
  client: Pick<ClientLinkOptions, 'links' | 'release' | 'installScript'>;
  /** Fastify logger; off by default. */
  logger?: boolean;
}

export function createServer(o: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, forceCloseConnections: true });
  installErrorHandling(app);
  // Every end of a session is logged and is an event of its user's (issue #439): early logouts can be told apart.
  const sessions = createUiSessions({
    repo: o.instance.uiSessions, clock: o.clock, signIn: o.signIn,
    ended: ({ userId, identity, reason }) => {
      console.warn(`hopper: UI session ended (${reason}): ${identity.realm} ${identityName(identity)} as user ${userId}`);
      o.tenants.user(userId)?.store.events.append({ type: 'ui_session.ended', data: { reason, realm: identity.realm } });
    },
    // Signed in with GitHub, the session ends with the user's GitHub connection (issue #513).
    connectionEnded: (userId) => o.tenants.user(userId)?.connectedAccounts.expired('github') === true,
    unknown: () => console.warn('hopper: a request carried a UI session token this hopper holds no session for: it ended before, the database was reset, or it is another hopper\'s; the UI signs in again'),
  });
  // The sign-in config may have changed since the sessions were made: a realm removed or off, or a rule, ends them.
  const r = sessions.reconcile(o.signIn.roleOf);
  if (r.dropped + r.changed > 0) console.warn(`hopper: the sign-in config applied to stored UI sessions: ${r.dropped} ended, ${r.changed} changed role`);
  installHostGuard(app, { port: o.port, lan: o.lan, sessions });
  installTenancy(app, { tenants: o.tenants, sessions, signIn: o.signIn, port: o.port, lan: o.lan });
  const tenant = { tenant: (req: Parameters<typeof tenantOf>[1]) => tenantOf(o.tenants, req) };
  apiReferenceRoutes(app, o.version);
  jobRoutes(app, tenant);
  stateRoutes(app, { ...tenant, clock: o.clock, version: o.version, port: o.port, sandboxes: o.sandboxes });
  questionRoutes(app, tenant);
  reviewRoutes(app, tenant);
  sectionRoutes(app, tenant);
  loginRoutes(app, { ...tenant, sessions, clock: o.clock });
  failureRoutes(app, tenant);
  minorDecisionRoutes(app, tenant);
  questionGatesRoutes(app, tenant);
  jobRulesRoutes(app, tenant);
  webhookRoutes(app, tenant);
  vaultRoutes(app, tenant);
  sourceRoutes(app, tenant);
  accountRoutes(app, tenant);
  connectedAccountsRoutes(app, tenant);
  sseRoutes(app, tenant);
  updateRoutes(app, o);
  pluginStoreRoutes(app, o);
  // What is the instance's is an instance admin's alone (issue #240).
  const instanceAdmin = createInstanceAdmin({ signIn: o.signIn, instance: o.instance });
  userRoutes(app, { tenants: o.tenants, instanceAdmin });
  instanceRoutes(app, { tenants: o.tenants, clock: o.clock, instanceAdmin });
  usageHistoryRoutes(app, { ...tenant, tenants: o.tenants, clock: o.clock, instanceAdmin });
  machineHistoryRoutes(app, { ...tenant, clock: o.clock });
  const realms = createRealmsAdmin({ instance: o.instance, environment: o.signInEnvironment, signIn: o.signIn, sessions });
  realmRoutes(app, { realms, instanceAdmin });
  accessRoutes(app, { access: o.access, instanceAdmin });
  clientLinkRoutes(app, { ...o.client, tenants: o.tenants, instance: o.instance, clock: o.clock, port: o.port, lan: o.lan });
  // A running job asks the hopper for GitHub (issue #563), with its own proxy token.
  jobGitHubRoutes(app, { tenants: o.tenants, clock: o.clock });
  // A running job asks the hopper what it can set up, and loads one skill (issue #582), with the same token.
  jobSkillRoutes(app, { tenants: o.tenants, access: o.access });
  staticRoutes(app, o.uiDir);
  registerUiRoutes(app, {
    ...tenant, tenants: o.tenants, instance: o.instance, sessions, signIn: o.signIn, realms, pluginStore: o.pluginStore, port: o.port, lan: o.lan, clock: o.clock,
    updater: o.updater, instanceAdmin, access: o.access, sandboxes: o.sandboxes,
  });
  return app;
}
