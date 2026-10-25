// The HTTP edge: read-only routes, SSE, the static UI, the API reference, and the UI session — the
// only way to mutate (design.md "Phase 3"). Loopback, plus the LAN names when set; every request
// passes the Host guard (AGENTS.md).
import { watchEventLoop, type EventLoopStall } from './event-loop.ts';
import type { HeldWatch } from './event-loop-held.ts';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { accessRoutes } from './access.ts';
import { artifactLibRoutes } from '../artifacts/libs.ts';
import { artifactRoutes, createArtifactEdge } from './artifacts.ts';
import { jobArtifactRoutes } from './job-artifacts.ts';
import { jobInfraPlanRoutes } from './job-infra-plans.ts';
import { apiReferenceRoutes } from './api-reference.ts';
import { helpRoutes } from './help.ts';
import type { Access } from '../authz/service.ts';
import { clientLinkRoutes, type ClientLinkOptions } from './client-link.ts';
import type { SignIn } from '../auth/index.ts';
import type { Clock, InstanceEvents, InstanceStore, PluginStoreView, Updater } from '../domain/ports.ts';
import { slowStoreCalls } from '../store/slow-calls.ts'; import { startedProcesses } from './event-loop-processes.ts';
import type { ClusterInstall, StackDrift } from '../domain/types.ts';
import { accountRoutes } from './accounts.ts';
import { installErrorHandling } from './errors.ts';
import { connectedAccountsRoutes } from './connected-accounts.ts';
import { installHostGuard } from './host-guard.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import { tunnelAgentRoutes, type RemoteAccess } from './remote-access.ts';
import { githubDeliveryRoutes, type GitHubDeliveries } from './github-deliveries.ts';
import { installTunnelEdge } from './tunnel.ts';
import { jobRoutes } from './jobs.ts'; import { tokenLedgerRoutes } from './token-ledger.ts'; import { deliveryForecastRoutes } from './delivery-forecast.ts'; import { deliveryLedgerRoutes } from './delivery-ledger.ts'; import { deliveryTrackRoutes } from './delivery-tracks.ts';
import { jobGitHubRoutes } from './job-github.ts';
import { jobGitRoutes } from './job-git.ts';
import type { GitPushes } from '../github-proxy/index.ts';
import { jobAddressRoutes } from './job-address.ts';
import { jobSkillRoutes } from './job-skill.ts';
import { jobStepRoutes } from './job-step.ts';
import { jobStreamRoutes } from './job-stream.ts';
import { jobCheckpointRoutes } from './job-checkpoint.ts';
import { jobTopologyRoutes } from './job-topology.ts'; import { jobRequirementsRoutes } from './job-requirements.ts'; import { jobHeavyRoutes } from './job-heavy.ts'; import { jobParkRoutes } from './job-park.ts'; import { jobRelayRoutes } from './job-relay.ts';
import { jobLoginRoutes } from './job-login.ts';
import { pluginStoreRoutes } from './plugin-store.ts';
import { jobRulesRoutes } from './job-rules.ts';
import { questionGatesRoutes } from './question-gates.ts';
import { failureRoutes } from './failures.ts';
import { workItemRoutes } from './work-items.ts';
import { minorDecisionRoutes } from './minor-decisions.ts';
import { loginRoutes } from './logins.ts';
import { reviewRoutes } from './reviews.ts';
import { sectionRoutes } from './sections.ts';
import { questionRoutes } from './questions.ts';
import { createRealmsAdmin, realmRoutes } from './realms.ts';
import { createLocalAccountsAdmin, localAccountRoutes } from './local-accounts.ts';
import { createPasskeys } from '../auth/passkeys.ts';
import { createApiGrants } from './ui/api-grants.ts';
import { createDpopProofs } from './ui/dpop.ts';
import { actionFields, routeScopeRegistry } from './scopes.ts';
import { sourceRoutes } from './sources.ts';
import { sseRoutes } from './sse.ts';
import { installInstanceTag, instanceTagOf } from './instance-tag.ts';
import { stateRoutes } from './state.ts';
import { staticRoutes } from './static.ts';
import { installTenancy, tenantOf, type Tenants } from './tenants.ts';
import { registerUiRoutes } from './ui/index.ts';
import type { AllowedHosts } from './allowed-hosts.ts'; import type { TelemetrySettingsService } from '../telemetry/settings.ts';
import type { SourceEmailMatch } from './source-email-match.ts'; import type { InfraApplies } from './infra-applies.ts';
import type { CloudLink } from './cloud-link.ts';
import type { DisplayName } from './display-name.ts';
import type { CallerOf } from './ui/sign-in.ts';
import type { Sandboxes } from '../sandbox/service.ts'; import type { Playground } from '../sandbox/playground.ts';
import { createUiSessions, identityName } from './ui/sessions.ts';
import { updateRoutes } from './update.ts';
import { masterKeyRoutes, type MasterKeyStatus } from './master-key.ts';
import type { RateLimiterControl } from '../github-limiter/settings.ts';
import { instanceRoutes } from './instance.ts';
import { usageHistoryRoutes } from './usage-history.ts';
import { machineHistoryRoutes } from './machine-history.ts';
import { stackResourceRoutes } from './stack-resources.ts';
import type { StackResourcesReader } from '../stack-resources/index.ts';
import { userRoutes } from './users.ts';
import { createInstanceAdmin } from './instance-admin.ts';
import { vaultRoutes } from './vault.ts';
import { bugReportReadRoutes } from './ui/bug-reports.ts';
import { issueDraftReadRoutes } from './ui/issue-drafts.ts';
import { pointedJobReadRoutes } from './ui/pointed-jobs.ts';
import { directJobReadRoutes } from './ui/direct-jobs.ts';
import { searchReadRoutes } from './search.ts';
import { githubWatchReadRoutes } from './ui/github-watches.ts'; import { pendingApprovalReadRoutes } from './ui/pending-approvals.ts';
import { componentWatcherReadRoutes } from './ui/component-watchers.ts';
import { landingBatchReadRoutes } from './ui/landing-batches.ts'; import { deliverySettingsReadRoutes } from './ui/delivery-settings.ts';
import { infraPlanReadRoutes } from './ui/infra-plans.ts';
import { webhookRoutes } from './webhooks.ts';
import { instrumentHttp } from '../telemetry/http.ts'; import { telemetrySummary } from '../telemetry/summary.ts';

export type { TenantParts, Tenants } from './tenants.ts';
export { installTunnelEdge, tunnelCaller, watchTunnel, type TunnelWatch } from './tunnel.ts';
export { createRemoteAccess, type RemoteAccess } from './remote-access.ts';
export { createGitHubDeliveries, type GitHubDeliveries } from './github-deliveries.ts';
export { createAllowedHosts } from './allowed-hosts.ts';
export { createSourceEmailMatch } from './source-email-match.ts'; export { createInfraApplies } from './infra-applies.ts';
export { createCloudLink } from './cloud-link.ts'; export { createCloudLinkParts } from './cloud-link-agent.ts';
export { createDisplayName } from './display-name.ts';
export { kernelVersion, runsInWsl } from './ui/host-link.ts';
export type { TailnetSource } from './tailnet.ts';

export interface ServerOptions {
  /** The instance store: UI sessions, login codes, the users and their identity links, the sign-in config. */
  instance: Pick<InstanceStore, 'uiSessions' | 'apiGrants' | 'loginCodes' | 'joinCodes' | 'lanePoolKeys' | 'users' | 'identities' | 'localAccounts' | 'localAccountPasskeys' | 'signInConfig' | 'settings' | 'stackHistory' | 'tx'>;
  /** Every user's running parts (issue #158): a tenant route reads and changes the request's user's. */
  tenants: Tenants;
  /** Where each job's push is kept as a saga before it reaches GitHub (issue #1806). Absent: kept nowhere. */
  gitPushes?: GitPushes;
  /** The plugin store (the instance's): GET /api/plugin-store, POST /ui/api/plugin-store. */
  pluginStore: PluginStoreView;
  /** Self-update (the instance's): GET /api/update, POST /ui/api/update. */
  updater: Updater;
  /** The build's directory, whose compose.yaml GET /api/update/compose serves (issue #697); default this build's. */
  buildDir?: string;
  /** How the stack differs from the compose file of this version (issue #697): GET /api/update/drift. */
  stackDrift?: () => Promise<StackDrift>;
  /** Set for a cluster install (issue #1285): the agent update skill is helm upgrade, and no compose file is offered. */
  cluster?: ClusterInstall | undefined;
  /** Access (issue #559, the instance's): GET /api/access, POST /ui/api/access. */
  access: Access;
  /** The sandboxes the hopper starts, one per step (issue #1349): GET /api/sandboxes. */
  sandboxes: Sandboxes;
  /** The sandbox playground (issue #1410): GET /api/sandbox-playground, POST /ui/api/sandbox-playground. */
  playground: Playground;
  /** The master key's status (issue #659): GET /api/master-key, POST /ui/api/master-key. */
  masterKey: MasterKeyStatus;
  /** The shared GitHub rate limiter's settings (issue #436): GET /api/github-rate-limiter, POST /ui/api/github-rate-limiter. */
  rateLimiter: RateLimiterControl;
  /** What every container of the stack and its Postgres use (issue #947): GET /api/resources. */
  stackResources: StackResourcesReader;
  /** Remote access (issue #880): GET /api/remote-access, POST /ui/api/remote-access, and the tunnel service's GET /tunnel/agent. */
  remoteAccess: RemoteAccess;
  /** GitHub deliveries (issue #1079): POST /github/webhook, GET /api/github-deliveries, POST /ui/api/github-deliveries. */
  githubDeliveries: GitHubDeliveries;
  /** The hosts the admin allowed and this host's tailnet (issue #1024): GET /api/allowed-hosts, POST /ui/api/allowed-hosts. `lan` reads them. */
  allowedHosts: AllowedHosts;
  /** The telemetry setting (issue #1486): GET /api/telemetry-settings, POST /ui/api/telemetry-settings. */
  telemetrySettings: TelemetrySettingsService;
  /** The source email match (issue #1380): GET /api/source-email-match, POST /ui/api/source-email-match. */
  sourceEmailMatch: SourceEmailMatch; infraApplies: InfraApplies; // and infra applies (issue #1722): GET /api/infra-applies, POST /ui/api/infra-applies
  /** The cloud link (issue #467): GET /api/cloud-link, POST /ui/api/cloud-link and /ui/api/cloud-link/unlink. */
  cloudLink: CloudLink;
  /** The instance's display name and instance id (issue #465): GET /api/display-name, POST /ui/api/display-name. */
  displayName: DisplayName;
  /** The hopper runs in WSL (issue #712): GET /api/host-link says so, for Settings' Windows hint. */
  wsl: boolean;
  /** The instance's events (every user's log): an event loop stall is raised there (issue #1154). Absent: only logged. */
  events?: Pick<InstanceEvents, 'append'>;
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
  /** Who a request counts as for the sign-in limit (issue #795): `tunnelCaller` of the tunnel watch; default its address. */
  caller?: CallerOf;
  /** The built UI bundle (ui/dist). */
  uiDir: string;
  /** Machines joining and dialling in (issue #308): their links, the client release, the install script. */
  client: Pick<ClientLinkOptions, 'links' | 'release' | 'installScript' | 'poolKey'>;
  /** Fastify logger; off by default. */
  logger?: boolean;
  /** The thread that reads where the event loop is held (issue #1383); absent: a stall does not say. */
  held?: HeldWatch;
}

export function createServer(o: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, forceCloseConnections: true });
  // Every request a span, its latency recorded (issue #1486): first, so the guards' answers are measured too.
  instrumentHttp(app);
  installErrorHandling(app);
  // Every answer names its hopper (issue #1295): the page drops another hopper's at the same address.
  const instanceTag = instanceTagOf(o.instance.settings.instanceId());
  installInstanceTag(app, instanceTag);
  // The event loop watchdog (issue #1002): a stall is logged with the routes in flight and the store calls in it
  // (issue #1154) and the processes started in it (issue #2367), shown on /api/health, and raised as an instance event.
  const events = o.events;
  const loop = watchEventLoop(app, {
    clock: o.clock, warn: (line) => console.warn(line), storeCalls: slowStoreCalls.totals, processes: startedProcesses.totals, ...(o.held ? { held: o.held } : {}),
    ...(events ? { raise: ({ at: _at, ...data }: EventLoopStall & { skipped: number }) => { events.append({ type: 'hopper.event_loop_stalled', data }); } } : {}),
  });
  // Every end of a session is logged and is an event of its user's (issue #439): early logouts can be told apart.
  const sessions = createUiSessions({
    repo: o.instance.uiSessions, clock: o.clock, signIn: o.signIn,
    ended: ({ userId, identity, reason }) => {
      console.warn(`hopper: UI session ended (${reason}): ${identity.realm} ${identityName(identity)} as user ${userId}`);
      o.tenants.user(userId)?.store.events.append({ type: 'ui_session.ended', data: { reason, realm: identity.realm } });
    },
    unknown: (why) => console.warn(`hopper: a request carried a UI session token that names no live session (${why}); the UI signs in again`),
  });
  // The sign-in config may have changed since the sessions were made: a realm removed or off, or a rule, ends them.
  const r = sessions.reconcile(o.signIn.roleOf);
  if (r.dropped + r.changed > 0) console.warn(`hopper: the sign-in config applied to stored UI sessions: ${r.dropped} ended, ${r.changed} changed role`);
  // Grants (issue #881): each mint, refresh, reuse and end is logged and is an event of its user's, which notifiers pass on.
  const grants = createApiGrants({
    repo: o.instance.apiGrants, sessions, clock: o.clock, roleOf: o.signIn.roleOf,
    recorded: (userId, e) => {
      if (e.type === 'api_grant.reuse_detected') console.warn(`hopper: grant ${e.data.grant} (${e.data.label}) of user ${userId}: a spent refresh token was sent again; the grant is revoked`);
      if (e.type === 'api_grant.revoked') console.warn(`hopper: grant ${e.data.grant} (${e.data.label}) of user ${userId} ended (${e.data.reason})`);
      o.tenants.user(userId)?.store.events.append(e);
    },
  });
  const g = grants.reconcile(o.signIn.roleOf);
  if (g.dropped + g.changed > 0) console.warn(`hopper: the sign-in config applied to grants: ${g.dropped} ended, ${g.changed} lowered`);
  // DPoP proofs (issue #892, "Sender binding"): one cache of the jti seen, for the token routes and every use of a bound grant's token.
  const proofs = createDpopProofs({ clock: o.clock });
  installHostGuard(app, { port: o.port, lan: o.lan, sessions });
  // Through a tunnel only the API, and a limit per caller (issues #795, #968): the tunnel's edge, held here too.
  installTunnelEdge(app, { tunnel: o.remoteAccess.watch, domain: () => { const u = o.remoteAccess.url(); return u ? new URL(u).hostname : undefined; } });
  installTenancy(app, { tenants: o.tenants, sessions, grants, proofs, signIn: o.signIn, access: o.access, port: o.port, lan: o.lan, actionField: actionFields() });
  const tenant = { tenant: (req: Parameters<typeof tenantOf>[1]) => tenantOf(o.tenants, req) };
  apiReferenceRoutes(app, o.version);
  helpRoutes(app, o.version);
  jobRoutes(app, tenant); tokenLedgerRoutes(app, tenant); deliveryForecastRoutes(app, { ...tenant, clock: o.clock }); deliveryLedgerRoutes(app, tenant); deliveryTrackRoutes(app, tenant);
  stateRoutes(app, { ...tenant, clock: o.clock, version: o.version, port: o.port, sandboxes: o.sandboxes, stall: loop.last });
  questionRoutes(app, tenant);
  reviewRoutes(app, tenant);
  sectionRoutes(app, tenant);
  loginRoutes(app, { ...tenant, sessions, clock: o.clock });
  failureRoutes(app, tenant);
  workItemRoutes(app, tenant);
  minorDecisionRoutes(app, tenant);
  questionGatesRoutes(app, { ...tenant, clock: o.clock });
  jobRulesRoutes(app, tenant);
  webhookRoutes(app, tenant);
  vaultRoutes(app, tenant);
  bugReportReadRoutes(app, tenant); // Your reports (issue #694)
  issueDraftReadRoutes(app, tenant); // File an issue (issue #471)
  pointedJobReadRoutes(app, tenant); // Pointed jobs (issue #425)
  directJobReadRoutes(app, tenant); // Direct jobs (issue #901)
  searchReadRoutes(app, tenant); // Search (issue #945)
  githubWatchReadRoutes(app, tenant); pendingApprovalReadRoutes(app, tenant); // GitHub watches (issue #427), pending approvals (issue #2088)
  landingBatchReadRoutes(app, tenant); deliverySettingsReadRoutes(app, tenant); // Landing batches (issue #1073), delivery settings (issue #2554)
  infraPlanReadRoutes(app, tenant); // Infra (issue #870)
  sourceRoutes(app, tenant);
  accountRoutes(app, tenant);
  connectedAccountsRoutes(app, tenant);
  sseRoutes(app, { ...tenant, instanceTag });
  updateRoutes(app, o);
  masterKeyRoutes(app, o);
  pluginStoreRoutes(app, o);
  // What is the instance's is an instance admin's alone (issue #240).
  const instanceAdmin = createInstanceAdmin({ signIn: o.signIn, instance: o.instance });
  userRoutes(app, { tenants: o.tenants, instanceAdmin });
  instanceRoutes(app, { tenants: o.tenants, clock: o.clock, instanceAdmin });
  usageHistoryRoutes(app, { ...tenant, tenants: o.tenants, clock: o.clock, instanceAdmin });
  machineHistoryRoutes(app, { ...tenant, clock: o.clock });
  stackResourceRoutes(app, { stackResources: o.stackResources, history: o.instance.stackHistory, instanceAdmin, clock: o.clock, process: loop.reading, telemetry: telemetrySummary.read });
  componentWatcherReadRoutes(app, { ...tenant, instanceAdmin }); // Component watchers (issue #1077): the stack's only for the instance admin
  const realms = createRealmsAdmin({ instance: o.instance, environment: o.signInEnvironment, signIn: o.signIn, sessions, grants });
  realmRoutes(app, { realms, instanceAdmin });
  // Local accounts (issue #1380): the hopper's own email and password sign-in.
  const localAccounts = createLocalAccountsAdmin({ instance: o.instance, signIn: o.signIn, sessions, grants, clock: o.clock });
  const passkeys = createPasskeys({ accounts: o.instance.localAccounts, passkeys: o.instance.localAccountPasskeys, clock: o.clock });
  localAccountRoutes(app, { localAccounts, instanceAdmin });
  accessRoutes(app, { access: o.access, instanceAdmin });
  clientLinkRoutes(app, { ...o.client, tenants: o.tenants, instance: o.instance, clock: o.clock, port: o.port, lan: o.lan, heldSince: loop.heldSince });
  // A running job asks the hopper for GitHub (issue #563), with its own proxy token.
  const { proxy: github, prWaits } = jobGitHubRoutes(app, { tenants: o.tenants, clock: o.clock });
  jobGitRoutes(app, { tenants: o.tenants, ...(o.gitPushes ? { pushes: o.gitPushes } : {}) });
  jobCheckpointRoutes(app, { tenants: o.tenants });
  // A running job says what came of a login it asked for (issue #1110), with the same token.
  jobLoginRoutes(app, { tenants: o.tenants });
  // A machine's probe asks where it reaches the hopper (issue #698).
  jobAddressRoutes(app);
  // GitHub, or a relay in front, sends its deliveries (issue #1079), signed with the GitHub webhook secret.
  githubDeliveryRoutes(app, { deliveries: o.githubDeliveries });
  // The tunnel service asks for its settings (issue #880), with its preshared key; never through the tunnel.
  const peers = peerList(o.lan.peers);
  tunnelAgentRoutes(app, { remoteAccess: o.remoteAccess, isPublic: (req) => {
    const r = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    return !('reach' in r) || r.reach === 'public';
  } });
  // A running job asks the hopper what it can set up, and loads one skill (issue #582), with the same token.
  const skillWaits = jobSkillRoutes(app, { tenants: o.tenants, access: o.access });
  // A running job subscribes to its job stream (issue #613), with the same token: what it waits on is asked again.
  jobStreamRoutes(app, { tenants: o.tenants, subscribed: (userId, jobId) => { void skillWaits.redrive(userId, jobId); prWaits.redrive(userId, jobId); } });
  // Artifacts (issue #624): a running job puts them with the same token; a person reads them, and their content is
  // served off /api/ under the policy of its kind, by a signed URL or a public link.
  const artifactEdge = createArtifactEdge({ clock: o.clock, lan: o.lan, port: o.port, tenants: o.tenants, hostLinkBase: () => o.instance.settings.getHostLinkBase() });
  jobArtifactRoutes(app, { tenants: o.tenants, edge: artifactEdge, github });
  jobInfraPlanRoutes(app, { tenants: o.tenants }); // Infra plans (issue #870), with the same token
  jobTopologyRoutes(app, { tenants: o.tenants }); jobRequirementsRoutes(app, { tenants: o.tenants }); jobHeavyRoutes(app, { tenants: o.tenants }); jobRelayRoutes(app, { tenants: o.tenants, port: o.port, lan: o.lan }); // the topology (issue #1905), push requirements (issue #2555), heavy steps (issue #2622), and the relay to a bastion (issue #2146), with the same token
  jobParkRoutes(app, { tenants: o.tenants }); // park and pick up a proposal or a research report (issue #2167), with the same token
  jobStepRoutes(app, { tenants: o.tenants, skillWaits }); // sandbox steps, Windows (issue #731) and Linux (issue #1007), with the same token
  artifactRoutes(app, { ...tenant, tenants: o.tenants, access: o.access, edge: artifactEdge, clock: o.clock });
  staticRoutes(app, o.uiDir);
  artifactLibRoutes(app, join(o.uiDir, 'artifact-lib'));
  registerUiRoutes(app, {
    ...tenant, tenants: o.tenants, instance: o.instance, sessions, grants, proofs, scopeRegistry: routeScopeRegistry(), signIn: o.signIn, realms, localAccounts, passkeys, pluginStore: o.pluginStore, port: o.port, lan: o.lan, clock: o.clock, caller: o.caller ?? ((req) => req.ip),
    updater: o.updater, instanceAdmin, access: o.access, playground: o.playground, artifacts: artifactEdge, masterKey: o.masterKey, rateLimiter: o.rateLimiter, remoteAccess: o.remoteAccess, githubDeliveries: o.githubDeliveries, allowedHosts: o.allowedHosts, telemetrySettings: o.telemetrySettings, sourceEmailMatch: o.sourceEmailMatch, infraApplies: o.infraApplies, cloudLink: o.cloudLink, displayName: o.displayName, hostLink: o.instance.settings, wsl: o.wsl,
  });
  return app;
}
