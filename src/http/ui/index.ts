// The UI session and the only mutations left (design.md "UI session and mutations"): a one-time
// login code (when the sign-in config leaves local sign-in on), no sign-in or a realm (sign-in.ts) → a page
// that keeps the session token in localStorage → POST /ui/api/* with that token in
// x-hopper-session, exact Origin, same-origin, JSON, and a role that allows it (design.md
// "Sign-in: realms"). Every refusal is a logged 403; only one with no live session says `session: 'ended'`, the one the
// UI reads as signed out (issue #696). A logged-in admin hands another
// device a login link per LAN name (design.md "Reaching the UI across the LAN"). A mutation acts for the
// session's user only (issue #158); the instance's (update, plugin store, users, realms) need admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isSuperAdmin, type SignIn } from '../../auth/index.ts';
import { registerLocalAccountRoutes } from './local-accounts.ts';
import type { Clock, InstanceStore, PluginStoreView, Updater } from '../../domain/ports.ts';
import { ACCESS_UNAVAILABLE, MAX_HISTORY_RETENTION_DAYS, HERDR_SESSION, HOST_KEY, LIST_ROLES, QUEUE_GATE_MODES, REALM_TYPES, ROLES, SELECTABLE_ROLES, UI_ROLES, type RealmsEdit, type RealmsView, type SessionView, type UiRole, type UserAdded } from '../../domain/types.ts';
import { registerConnectedAccountsRoutes } from './connected-accounts.ts';
import { registerGitLabAccountRoutes } from './gitlab-account.ts';
import { HttpError, parseWith } from '../errors.ts';
import { lanHosts, uiOrigins, type Lan } from '../reach.ts';
import type { RealmsAdmin } from '../realms.ts';
import { writeJobRules } from '../../job-rules/index.ts';
import { writeRules } from '../../questions/index.ts';
import { signedInOf, userIdOf, type TenantParts, type Tenants } from '../tenants.ts';
import { usageGraphViewBody } from '../usage-history.ts';
import { mutationRefusal, sessionIn } from './guard.ts';
import { apiTokenAnswer, registerApiTokenRoutes } from './api-tokens.ts';
import { isBoxAction } from './box-actions.ts';
import { loginCodeLive, mintLoginCode } from './login-code.ts';
import { registerMachineJoinRoutes } from './machine-join.ts'; import { registerSandboxPlaygroundRoutes } from './sandbox-playground.ts'; import { registerHeaderBadgeRoutes } from './header-badges.ts'; import { registerMemoryAlertRoutes } from './memory-alert.ts'; import { registerDiskBudgetRoutes } from './disk-budget.ts'; import { registerDiskDefaultsRoutes } from './disk-defaults.ts'; import { registerLeftoverRoutes } from './leftovers.ts'; import { registerMachineDrainRoutes } from './machine-drains.ts'; import { registerSandboxHostRoutes } from './sandbox-host.ts'; import { registerWindowsLinkRoutes } from './windows-link.ts';
import { registerInstanceRoutes } from './instance.ts';
import { INSTANCE_ADMIN_ONLY, type InstanceAdmin } from '../instance-admin.ts';
import { identityName, personOf, sessionUser, type UiSession, type UiSessions } from './sessions.ts';
import { registerSignInRoutes, type CallerOf } from './sign-in.ts';
import { answerBody } from './job-bodies.ts';
import { questionView } from '../questions.ts';
import { ROUTE_GROUPS } from './route-groups.ts';
import { registerAutoAnswerRoutes } from './auto-answer.ts';
import { registerAccessRoutes } from './access.ts';
import { registerSharedSecretRoutes } from './vault-shared.ts';
import type { ArtifactEdge } from '../artifacts.ts';
import type { Access } from '../../authz/service.ts';
import { registerWebhookAndNotifierRoutes } from './webhooks-notifiers.ts';
import { knownTemplate } from './vault.ts';

/** The master key's status (issue #659): the one reveal, a person's word that they saved it; the shared GitHub rate limiter's settings (issue #436); remote access (issue #880). */
export interface UiRouteOptions extends Pick<Parameters<typeof registerInstanceRoutes>[1], 'masterKey' | 'rateLimiter' | 'remoteAccess' | 'githubDeliveries' | 'hostLink' | 'wsl' | 'allowedHosts' | 'telemetrySettings' | 'sourceEmailMatch' | 'infraApplies' | 'cloudLink' | 'displayName'> {
  /** The request's user's parts (the session's user). */
  tenant: (req: FastifyRequest) => TenantParts;
  tenants: Tenants;
  instance: Pick<InstanceStore, 'loginCodes' | 'joinCodes' | 'lanePoolKeys' | 'users'>;
  sessions: UiSessions;
  /** Grants (issue #881), and every scope a route needs. */
  grants: import('./api-grants.ts').ApiGrants; proofs: import('./dpop.ts').DpopProofs; scopeRegistry: import('../../domain/scope-registry.ts').ScopeRegistry;
  signIn: SignIn;
  /** Settings → Sign-in: the sign-in config's realms (issue #185), and the local accounts (issue #1380). */
  realms: RealmsAdmin; localAccounts: import('../local-accounts.ts').LocalAccountsAdmin; passkeys: import('../../auth/passkeys.ts').Passkeys;
  pluginStore: PluginStoreView;
  /** The bound port (known only after listen). */
  port: () => number;
  lan: Lan;
  /** Who a request counts as for the sign-in limit: its address, or the tunnel's caller (issue #795). */
  caller: CallerOf;
  clock: Clock;
  updater: Updater;
  /** Whether a session may do what is the instance's (issue #240). */
  instanceAdmin: InstanceAdmin;
  /** Access (issue #559): the instance's. */
  access: Access;
  /** Artifacts (issue #624): the signer of content URLs, and where people open the hopper; the sandbox playground (issue #1410). */
  artifacts: ArtifactEdge; playground: Parameters<typeof registerSandboxPlaygroundRoutes>[1]['playground'];
}

const idParams = z.object({ id: z.string() });
export const pluginsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('options'), role: z.enum(ROLES), name: z.string().min(1), options: z.record(z.string(), z.unknown()), rename: z.string().trim().min(1).max(64).optional(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('select'), role: z.enum(SELECTABLE_ROLES), plugin: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('add'), role: z.enum(LIST_ROLES), plugin: z.string().min(1), name: z.string().min(1), options: z.record(z.string(), z.unknown()).optional(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('remove'), role: z.enum(LIST_ROLES), name: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('move'), role: z.literal('escalation-level'), name: z.string().min(1), to: z.number().int().min(0), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('escalation-machine'), machine: z.string().min(1).nullable(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('rescan') }),
]);
// The plugin store (issue #75): ids only — what is installed is what the store catalogue lists.
// A plugin id, never a path: it names a directory under the plugin dir.
const pluginId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a plugin id');
// The plugin store setting (issue #445): the default plugin store, none, or a git repository — anything
// `git fetch` takes, never read as an option.
const storeRepo = z.string().trim().min(1, 'repo must name a git repository').max(2048).refine((r) => !r.startsWith('-'), 'repo must not start with -');
const pluginStoreSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('default') }), z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.literal('repo'), repo: storeRepo }),
]);
export const pluginStoreBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('refresh') }),
  z.strictObject({ action: z.literal('source'), source: pluginStoreSource }),
  z.strictObject({ action: z.literal('install'), id: pluginId }),
  z.strictObject({ action: z.literal('remove'), id: pluginId }),
]);
// The device link (issue #95): `keep` names the code the dialog shows; while it is live the same links come back.
export const deviceLinkBody = z.strictObject({ keep: z.string().optional() });
// Users (issue #158): add one, under a name no user has.
export const usersEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), name: z.string().trim().min(1, 'name must not be empty').max(64) }),
]);
export const rulesBody = z.strictObject({ text: z.string(), version: z.string().min(1) });
export const jobRulesBody = z.strictObject({ text: z.string(), version: z.string().min(1) });
// Realms (issue #185): one change to the sign-in config against the version read. A realm's own
// settings are checked by loading the changed settings, so a refusal names the field as a start would.
const realmName = z.string().min(1).max(64);
const realmsVersion = { version: z.string().min(1) };
const personRef = z.strictObject({ realm: realmName, subject: z.string().min(1).max(512) });
export const realmsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), name: realmName.optional(), realm: z.looseObject({ name: realmName, label: z.string().max(128).optional(), type: z.enum(REALM_TYPES) }), ...realmsVersion }),
  z.strictObject({ action: z.literal('remove'), name: realmName, ...realmsVersion }),
  z.strictObject({ action: z.literal('move'), name: realmName, to: z.number().int().min(0), ...realmsVersion }),
  z.strictObject({ action: z.literal('enable'), name: realmName, enabled: z.boolean(), ...realmsVersion }),
  z.strictObject({
    action: z.literal('settings'), local: z.boolean().optional(), none: z.enum(UI_ROLES).nullable().optional(),
    // How long a UI session lasts (issue #439); whether it loads is the sign-in config's check, naming the field.
    sessions: z.strictObject({ idleHours: z.number(), maxHours: z.number() }).optional(), ...realmsVersion,
  }),
  // Two admin tiers (issue #242): any admin makes an identity admin; only a super admin makes one super admin or hands it over.
  z.strictObject({ action: z.literal('admin'), who: personRef, ...realmsVersion }),
  z.strictObject({ action: z.literal('super-admin'), who: personRef, transfer: z.boolean().optional(), ...realmsVersion }),
]);
const machineName = z.string().trim().min(1).max(64);
const machineLanes = z.number().int().min(1, 'lanes must be at least 1');
const machineExecutors = z.array(z.string().min(1));
// Attach an ssh target (issue #74: editing and removing a machine is a plugins edit). ssh is a detected
// ssh target or a typed plain [user@]host (issue #293); session is never accepted (strict), nor any herdr binary (issue #311);
// hostKey is the one the person confirmed from POST /ui/api/machines/host-key (issue #293).
export const machinesEditBody = z.union([
  z.strictObject({
    name: machineName, ssh: z.string().min(1), lanes: machineLanes.optional(), executors: machineExecutors.optional(), label: z.string().trim().min(1).optional(),
    hostKey: z.string().regex(HOST_KEY, 'must be <type> <base64>, as the host key offer gives it').optional(), version: z.string().min(1),
  }),
  // This machine (issue #260): no ssh target; the herdr session its jobs run in, started by the daemon.
  z.strictObject({
    name: machineName, session: z.string().regex(HERDR_SESSION).refine((s) => s !== 'default', 'must not be the default herdr session').optional(),
    lanes: machineLanes.optional(), executors: machineExecutors.optional(), label: z.string().trim().min(1).optional(), version: z.string().min(1),
  }),
]);
// The machine defaults (issue #142): what a machine attached from the UI starts with.
export const machineHostKeyBody = z.strictObject({ ssh: z.string().min(1) });

export const machineDefaultsBody = z.strictObject({ lanes: machineLanes, executors: machineExecutors, version: z.string().min(1) });
// The queue gate (issue #159): the user order (distinct waiting jobs, first to last) and the gate itself.
export const queueOrderBody = z.strictObject({
  jobIds: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length, 'a job is named twice'),
});
// The usage graph (issue #385): the history retention, whole days.
/** The usage limits (issue #522): the same bounds as HOPPER_SOFT_LIMIT / HOPPER_HARD_LIMIT. */
const limitFraction = z.number().min(0, 'a limit is a fraction from 0 to 1').max(1, 'a limit is a fraction from 0 to 1');
/** The soft lanes (issue #2091): a whole number from 0; absent: the user's soft lanes stay as they are. */
const softLanes = z.number().int('the soft lanes are a whole number').min(0, 'the soft lanes must not be negative').optional();
export const usageLimitsBody = z.strictObject({ soft: limitFraction, hard: limitFraction, softLanes })
  .refine((b) => b.soft < b.hard, { message: 'the soft limit must be below the hard limit', path: ['soft'] });
export const historyRetentionBody = z.strictObject({ days: z.number().int().min(1, 'keep at least 1 day').max(MAX_HISTORY_RETENTION_DAYS) });
export { usageGraphViewBody };
export const queueGateBody = z.strictObject({ mode: z.enum(QUEUE_GATE_MODES), autoAcceptPerHour: z.number().int().min(1).nullable() });
// Connected accounts (issue #214): connect (start the device flow), cancel a waiting code, disconnect; take or drop a
// sign-in's held grant (issue #647).
const EDIT_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
/** The rules themselves are validated by the plugin host (the plugins config schema), so a refusal names the field. */
export const routingEditBody = z.strictObject({ rules: z.array(z.any()), version: z.string().min(1) });

const refuse = (req: FastifyRequest, reply: FastifyReply, why: string, needs?: UiRole, session?: 'ended') => {
  console.warn(`hopper: UI ${req.method} ${req.url} refused: ${why}`);
  return reply.code(403).send({ error: why, ...(needs ? { needs } : {}), ...(session ? { session } : {}) });
};


export function registerUiRoutes(app: FastifyInstance, o: UiRouteOptions): void {
  const { sessions, signIn } = o;
  /** The session's user's name (the user may be gone from a stale session's view: its id then). */
  const userName = (s: UiSession): string => o.instance.users.get(s.userId)?.name ?? s.userId;
  const sessionOf = (req: FastifyRequest): UiSession | undefined => sessionIn(req.headers, sessions);

  app.get('/ui/api/session', async (req): Promise<SessionView> => {
    const s = sessionOf(req);
    const offer = {
      local: signIn.local, none: signIn.none, password: signIn.password, passkeys: o.passkeys.any(), gateway: signIn.gateway, origin: signIn.origin(), realms: signIn.realms(), devices: signIn.devices(), required: o.instance.users.list().length > 1,
    };
    if (s) return { authenticated: true, expiresAt: s.expiresAt, user: sessionUser(s, userName(s), isSuperAdmin(signIn.config(), s.identity), o.instanceAdmin(s)), signIn: offer };
    const id = userIdOf(req);
    const viewing = id === undefined ? undefined : o.instance.users.get(id);
    return viewing ? { authenticated: false, viewing: { id: viewing.id, name: viewing.name }, signIn: offer } : { authenticated: false, signIn: offer };
  });

  registerSignInRoutes(app, {
    sessions, signIn, refuse, caller: o.caller, instance: o.instance, clock: o.clock, isUiOrigin: (origin) => uiOrigins(o.port(), o.lan).includes(origin), passkeys: o.passkeys,
    userFor: (who) => o.tenants.signInAs(who),
    connect: (userId, connection) => o.tenants.user(userId)?.connectedAccounts.adopt(connection),
    userName: (id) => o.instance.users.get(id)?.name ?? id,
    instanceAdmin: o.instanceAdmin,
  });

  /**
   * Why Access refuses the request's API token the role it needs (issue #718), or a box action (issue #795: a box token
   * only, and `can_run_on_box`), or undefined: allowed, or no API token.
   */
  const tokenRefusal = async (req: FastifyRequest, reply: FastifyReply, needs: UiRole): Promise<unknown> => {
    const s = sessionOf(req)!;
    if (s.kind !== 'api') return undefined;
    const d = await apiTokenAnswer(o.access, s, needs, isBoxAction(req.routeOptions.url), { grants: o.grants, method: req.method, route: req.routeOptions.url });
    if (d.allowed) return undefined;
    if (d.unavailable) return reply.code(503).send({ error: `${ACCESS_UNAVAILABLE}: ${d.reason}` });
    return refuse(req, reply, `the API token may not do this: ${d.reason}`);
  };
  // Each mutation names the least role that may make it (design.md "Sign-in" Roles); an API token's use is Access's too.
  const allow = (needs: UiRole) => ({ onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
    const r = mutationRefusal(req.headers, o.port(), o.lan, sessions, needs);
    if (r) return refuse(req, reply, r.why, r.needs, r.session);
    return tokenRefusal(req, reply, needs);
  } });
  const operator = allow('operator');
  const admin = allow('admin');
  // What is the instance's (issue #240): an admin session of the hopper's admin, not any admin session.
  const instance = { onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
    const r = mutationRefusal(req.headers, o.port(), o.lan, sessions, 'admin');
    if (r) return refuse(req, reply, r.why, r.needs, r.session);
    if (!o.instanceAdmin(sessionOf(req)!)) return refuse(req, reply, INSTANCE_ADMIN_ONLY, 'admin');
    return tokenRefusal(req, reply, 'admin');
  } };

  app.post('/ui/api/queue/order', operator, async (req) => o.tenant(req).engine.orderQueue(parseWith(queueOrderBody, req.body).jobIds));
  app.post('/ui/api/queue/accept-presort', operator, async (req) => ({ presort: o.tenant(req).engine.acceptPreSort() }));
  // The usage graph's range and step are the user's own choice, a viewer's too; the history retention deletes samples: admin.
  app.post('/ui/api/usage-history/view', allow('viewer'), async (req) => {
    const view = parseWith(usageGraphViewBody, req.body);
    o.tenant(req).store.settings.setUsageGraphView(view);
    return { view };
  });
  app.post('/ui/api/usage-history/retention', admin, async (req) => {
    const { days } = parseWith(historyRetentionBody, req.body);
    const { store } = o.tenant(req);
    store.settings.setHistoryRetentionDays(days);
    // Applied at once (issue #356): what is now past it goes.
    const before = new Date(o.clock.now().getTime() - days * 86_400_000);
    // The machine samples share it (issue #560).
    const pruned = store.usageHistory.prune(before) + store.machineHistory.prune(before);
    return { retentionDays: days, pruned };
  });
  // The usage limits (issue #522): read at every Decision, so they apply without a restart; the change wakes the engine.
  app.post('/ui/api/usage/limits', admin, async (req) => ({ limits: o.tenant(req).engine.setUsageLimits(parseWith(usageLimitsBody, req.body)) }));
  app.post('/ui/api/queue-gate', admin, async (req) => ({ gate: o.tenant(req).engine.setQueueGate(parseWith(queueGateBody, req.body)) }));

  app.post('/ui/api/questions/:id/answer', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { answer } = parseWith(answerBody, req.body);
    const r = o.tenant(req).questions.answerByHuman(id, answer);
    if (r.ok) return questionView(o.tenant(req), r.question);
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/close', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.tenant(req).questions.closeByHuman(id);
    if (r.ok) return questionView(o.tenant(req), r.question);
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/dismiss', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.tenant(req).questions.dismissByHuman(id);
    if (r.ok) return questionView(o.tenant(req), r.question);
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/seen', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.tenant(req).questions.markSeen(id);
    if (r.ok) return questionView(o.tenant(req), r.question);
    throw new HttpError(404, `question ${id} not found`);
  });

  // design.md "UI and mutation": one instance's options (command-bearing ones too, issue #198), the
  // plugin filling a one-instance role, or a rescan. Answers the new GET /api/plugins report.
  app.post('/ui/api/plugins', admin, async (req) => {
    const r = await o.tenant(req).plugins.edit(knownTemplate(o.tenant(req).vault, parseWith(pluginsEditBody, req.body)));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // design.md "Plugin store": read the store again, set the plugin store (issue #445), install (or update)
  // a plugin it lists, or remove a store install. Answers the new GET /api/plugin-store report.
  app.post('/ui/api/plugin-store', instance, async (req) => {
    const r = await o.pluginStore.edit(parseWith(pluginStoreBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // Question gates (issue #18): the rules, whole, against the version read (sha-256 of the text);
  // the next question reads them. Answers the new GET /api/question-gates rules.
  app.post('/ui/api/rules', admin, async (req) => {
    const { text, version } = parseWith(rulesBody, req.body);
    const r = writeRules(o.tenant(req).store.config, text, version);
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.view;
  });

  // Job rules (issue #172): whole, against the version read (sha-256 of the text); the next job to
  // start reads them. Answers the new GET /api/job-rules view.
  app.post('/ui/api/job-rules', admin, async (req) => {
    const { text, version } = parseWith(jobRulesBody, req.body);
    const r = writeJobRules(o.tenant(req).store.config, text, version);
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.view;
  });

  registerWebhookAndNotifierRoutes(app, { admin, tenant: o.tenant });
  // A job's actions (issue #501), a job source's intake actions (issue #440), the logins' (issue #476), the failures' (issue #509).
  for (const register of ROUTE_GROUPS) register(app, { operator, admin, tenant: o.tenant, tenants: o.tenants, grants: o.grants, edge: o.artifacts, access: o.access, clock: o.clock });
  registerAutoAnswerRoutes(app, { operator, admin, tenant: o.tenant, clock: o.clock });
  registerAccessRoutes(app, { instance, access: o.access, by: (req) => personOf(signedInOf(req)!) });
  registerSharedSecretRoutes(app, { instance, tenant: o.tenant });
  registerApiTokenRoutes(app, { allow, instance, sessions, grants: o.grants, proofs: o.proofs, registry: o.scopeRegistry, sessionOf, access: o.access, tenants: o.tenants, signIn, caller: o.caller, clock: o.clock });

  // design.md "Machines from the UI" (issues #18, #74): attach an ssh target as a new `ssh` instance
  // in the plugins config `machines:`; applies without a restart. Answers the new GET /api/machines/config.
  app.post('/ui/api/machines', admin, async (req) => {
    const r = await o.tenant(req).plugins.editMachines(parseWith(machinesEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.config;
  });

  // Issue #293: the host key a new ssh target would be pinned to — the one ~/.ssh/known_hosts holds, else
  // the one it presents now — with its fingerprint, for the person to confirm before the add. Writes nothing.
  app.post('/ui/api/machines/host-key', admin, async (req) => {
    const r = await o.tenant(req).plugins.machineHostKey(parseWith(machineHostKeyBody, req.body).ssh);
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.offer;
  });

  // Add machine (issue #308): a join code for the line (src/http/ui/machine-join.ts). A sandbox never joins as a machine (issue #1349).
  registerMachineJoinRoutes(app, { admin, tenant: o.tenant, instance: o.instance, clock: o.clock }); registerSandboxPlaygroundRoutes(app, { admin, tenant: o.tenant, playground: o.playground }); registerMemoryAlertRoutes(app, { admin, tenant: o.tenant }); registerHeaderBadgeRoutes(app, { viewer: allow('viewer'), tenant: o.tenant }); registerDiskBudgetRoutes(app, { admin, tenant: o.tenant }); registerDiskDefaultsRoutes(app, { admin, tenant: o.tenant }); registerLeftoverRoutes(app, { operator, tenant: o.tenant }); registerMachineDrainRoutes(app, { admin, tenant: o.tenant }); registerSandboxHostRoutes(app, { admin, tenant: o.tenant }); registerWindowsLinkRoutes(app, { admin, tenant: o.tenant, clock: o.clock }); // the sandbox playground (issue #1410), the memory alert (issue #868), the header badges (issue #1181), the disk budget (issue #1120), the disk defaults (issue #2494), the leftovers (issue #1116), draining a machine (issue #1511), the sandbox host (issue #2272), the Windows link report (issue #712)

  // Issue #142: the plugins config `machineDefaults:`, what a machine attached here starts with. Answers the new GET /api/machines/config.
  app.post('/ui/api/machines/defaults', admin, async (req) => {
    const r = await o.tenant(req).plugins.editMachineDefaults(parseWith(machineDefaultsBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.config;
  });

  // design.md "Routing rules (issue #18)": the whole ordered list into the plugins config `routing:`.
  // Answers the new GET /api/routing report. A rule change applies to new jobs and, on the next sync, to waiting jobs that have not started (issue #375).
  app.post('/ui/api/routing', admin, async (req) => {
    const r = await o.tenant(req).plugins.editRouting(parseWith(routingEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // Self-update, the master key, the shared GitHub rate limiter and remote access (issues #44, #659, #436, #880): the hopper's admin's alone.
  registerInstanceRoutes(app, { instance, instanceAdmin: o.instanceAdmin, updater: o.updater, masterKey: o.masterKey, rateLimiter: o.rateLimiter, remoteAccess: o.remoteAccess, githubDeliveries: o.githubDeliveries, allowedHosts: o.allowedHosts, telemetrySettings: o.telemetrySettings, sourceEmailMatch: o.sourceEmailMatch, infraApplies: o.infraApplies, cloudLink: o.cloudLink, hopperIoState: { tenants: o.tenants, updater: o.updater, clock: o.clock }, displayName: o.displayName, hostLink: o.hostLink, wsl: o.wsl, port: o.port, origins: () => o.artifacts.origins(), by: (req) => personOf(signedInOf(req)!) });

  // design.md "Connected accounts": the user's own accounts, their session's user alone (issues #214, #1380, #1448).
  registerConnectedAccountsRoutes(app, { admin, tenant: o.tenant, email: (req) => sessionOf(req)?.identity.email });
  // design.md "A GitLab source": the user's GitLab account, read and changed (issue #1448 part 2).
  registerGitLabAccountRoutes(app, { admin, tenant: o.tenant, email: (req) => sessionOf(req)?.identity.email });

  // A login code as a link per LAN name, in the fragment (never sent to a server). The links
  // share one code: it works once, and expires like any other. `keep` (issue #95): the code the
  // dialog shows comes back while it is live; once used or expired, a fresh one is minted.
  app.post('/ui/api/device-link', admin, async (req) => {
    if (!signIn.local) throw new HttpError(409, 'local sign-in is off in the sign-in config: no login code to hand on');
    if (o.lan.names.length === 0) throw new HttpError(409, 'no LAN names: set HOPPER_LAN_NAMES and HOPPER_LAN_PEERS to reach the UI from another device');
    const { keep } = parseWith(deviceLinkBody, req.body ?? {});
    // The device signs in as the session's own user (issue #158).
    const userId = sessionOf(req)!.userId;
    const code = keep !== undefined && loginCodeLive(o.instance, o.clock, keep) === userId ? keep : mintLoginCode(o.instance, o.clock, userId);
    return { links: lanHosts(o.port(), o.lan).map((h) => `http://${h}/#login=${code}`) };
  });

  // Users (issue #158, design.md "Users: one hopper, separate users"): add a user — its schema, its
  // the plugins config, its runtime — and answer with a one-time login link for it per UI origin, to hand over.
  app.post('/ui/api/users', instance, async (req): Promise<UserAdded> => {
    const { name } = parseWith(usersEditBody, req.body);
    if (o.tenants.list().some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `the name ${name} is taken`);
    if (signIn.none !== null) throw new HttpError(409, 'no sign-in is on, and it signs everyone in as admin: turn it off (Settings → Sign-in) before adding a user');
    const user = await o.tenants.add(name);
    console.warn(`hopper: user ${user.id} added by ${identityName(sessionOf(req)!.identity)}`);
    const code = signIn.local ? mintLoginCode(o.instance, o.clock, user.id) : undefined;
    return {
      user: { id: user.id, name: user.name, createdAt: user.createdAt },
      links: code === undefined ? [] : uiOrigins(o.port(), o.lan).map((origin) => `${origin}/#login=${code}`),
    };
  });

  // Realms (issue #185, design.md "Sign-in: realms"): one change to the sign-in config, applied at once.
  // Answers the new GET /api/realms view.
  app.post('/ui/api/realms', instance, async (req): Promise<RealmsView> => o.realms.edit(parseWith(realmsEditBody, req.body) as RealmsEdit, sessionOf(req)!.identity));
  // Local accounts (issue #1380, design.md "Local accounts"): add, change or remove one; an account's own password change.
  registerLocalAccountRoutes(app, { instance, viewer: allow('viewer'), localAccounts: o.localAccounts, passkeys: o.passkeys, sessionOf, isUiOrigin: (origin) => uiOrigins(o.port(), o.lan).includes(origin) });

  app.post('/ui/api/logout', allow('viewer'), async (req) => {
    sessions.drop(sessionOf(req)!.token, 'logout');
    return { ok: true };
  });
}
