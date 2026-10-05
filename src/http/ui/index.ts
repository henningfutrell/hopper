// The UI session and the only mutations left (design.md "UI session and mutations"): a one-time
// login code (when auth.yaml leaves local sign-in on) or an identity provider (sign-in.ts) → a page
// that keeps the session token in localStorage → POST /ui/api/* with that token in
// x-hopper-session, exact Origin, same-origin, JSON, and a role that allows it (design.md
// "Sign-in: none, password, local, OIDC and SAML"). Every refusal is a logged 403. A logged-in admin hands another
// device a login link per LAN name (design.md "Reaching the UI across the LAN"). A mutation acts for the
// session's user only (issue #158); the instance's (update, plugin store, users) need admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SignIn } from '../../auth/index.ts';
import type { Clock, InstanceStore, PluginStoreView, Updater } from '../../domain/ports.ts';
import { LIST_ROLES, ROLES, SELECTABLE_ROLES, UPDATE_CHANNELS, type SessionView, type UiRole, type UserAdded } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import { lanHosts, uiOrigins, type Lan } from '../reach.ts';
import { writeRules } from '../../questions/index.ts';
import { routerView } from '../state.ts';
import { userIdOf, type TenantParts, type Tenants } from '../tenants.ts';
import { webhooksView } from '../webhooks.ts';
import { SESSION_HEADER, mutationRefusal } from './guard.ts';
import { loginCodeLive, mintLoginCode } from './login-code.ts';
import { sessionUser, type UiSession, type UiSessions } from './sessions.ts';
import { registerSignInRoutes } from './sign-in.ts';


export interface UiRouteOptions {
  /** The request's user's parts (the session's user). */
  tenant: (req: FastifyRequest) => TenantParts;
  tenants: Tenants;
  instance: Pick<InstanceStore, 'loginCodes' | 'users'>;
  sessions: UiSessions;
  signIn: SignIn;
  pluginStore: PluginStoreView;
  /** The bound port (known only after listen). */
  port: () => number;
  lan: Lan;
  clock: Clock;
  updater: Updater;
}

const idParams = z.object({ id: z.string() });
export const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
export const routerModeBody = z.object({ mode: z.enum(['shadow', 'active']) });
export const pluginsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('options'), role: z.enum(ROLES), name: z.string().min(1), options: z.record(z.string(), z.unknown()), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('select'), role: z.enum(SELECTABLE_ROLES), plugin: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('add'), role: z.enum(LIST_ROLES), plugin: z.string().min(1), name: z.string().min(1), options: z.record(z.string(), z.unknown()).optional(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('remove'), role: z.enum(LIST_ROLES), name: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('move'), role: z.literal('escalation-level'), name: z.string().min(1), to: z.number().int().min(0), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('rescan') }),
]);
// The plugin store (issue #75): ids only — what is installed is what the store catalogue lists.
// A plugin id, never a path: it names a directory under the plugin dir.
const pluginId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a plugin id');
export const pluginStoreBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('refresh') }),
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
// The content (url, events) is checked in the editor, so the UI shows one set of messages; here only
// the shape. No secret (issue #56), no secretFile, no new name; secretEnv only on add, and only a
// WEBHOOK_SECRET_* variable (checked in the editor).
const webhookFields = { name: z.string().min(1) };
export const webhooksEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), ...webhookFields, url: z.string(), events: z.array(z.string()), secretEnv: z.string(), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('edit'), ...webhookFields, url: z.string().optional(), events: z.array(z.string()).optional(), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('remove'), ...webhookFields }),
]);
const machineName = z.string().trim().min(1).max(64);
const machineLanes = z.number().int().min(1, 'lanes must be at least 1');
const machineExecutors = z.array(z.string().min(1));
// Attach an ssh target (issue #74: editing and removing a machine is a plugins edit). ssh is checked
// against the detected ssh targets; herdrBin, session and hostKey are never accepted (strict).
export const machinesEditBody = z.strictObject({
  name: machineName, ssh: z.string().min(1), lanes: machineLanes.optional(), executors: machineExecutors.optional(), label: z.string().trim().min(1).optional(), version: z.string().min(1),
});
// The machine defaults (issue #142): what a machine attached from the UI starts with.
export const machineDefaultsBody = z.strictObject({ lanes: machineLanes, executors: machineExecutors, version: z.string().min(1) });
// Self-update (issue #44): check now, apply the available update, or set the channel / auto-update.
export const updateBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('check') }),
  z.strictObject({ action: z.literal('apply') }),
  z.strictObject({ action: z.literal('settings'), channel: z.enum(UPDATE_CHANNELS).optional(), autoUpdate: z.boolean().optional() }),
]);
// gh login (issue #138): start gh's device flow, or end a waiting one.
export const ghLoginBody = z.strictObject({ action: z.enum(['start', 'cancel']) });
const EDIT_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
/** The rules themselves are validated by the plugin host (the plugins.yaml schema), so a refusal names the field. */
export const routingEditBody = z.strictObject({ rules: z.array(z.any()), version: z.string().min(1) });

const refuse = (req: FastifyRequest, reply: FastifyReply, why: string, needs?: UiRole) => {
  console.warn(`hopper: UI ${req.method} ${req.url} refused: ${why}`);
  return reply.code(403).send(needs ? { error: why, needs } : { error: why });
};

export function registerUiRoutes(app: FastifyInstance, o: UiRouteOptions): void {
  const { sessions, signIn } = o;
  /** The session's user's name (the user may be gone from a stale session's view: its id then). */
  const userName = (s: UiSession): string => o.instance.users.get(s.userId)?.name ?? s.userId;
  const sessionOf = (req: FastifyRequest): UiSession | undefined => {
    const header = req.headers[SESSION_HEADER];
    return sessions.find(typeof header === 'string' ? header : undefined);
  };

  app.get('/ui/api/session', async (req): Promise<SessionView> => {
    const s = sessionOf(req);
    const offer = {
      local: signIn.local, none: signIn.none, password: signIn.password, origin: signIn.origin(), providers: signIn.providers(), required: o.instance.users.list().length > 1,
    };
    if (s) return { authenticated: true, expiresAt: s.expiresAt, user: sessionUser(s, userName(s)), signIn: offer };
    const id = userIdOf(req);
    const viewing = id === undefined ? undefined : o.instance.users.get(id);
    return viewing ? { authenticated: false, viewing: { id: viewing.id, name: viewing.name }, signIn: offer } : { authenticated: false, signIn: offer };
  });

  registerSignInRoutes(app, {
    sessions, signIn, refuse, instance: o.instance, clock: o.clock, isUiOrigin: (origin) => uiOrigins(o.port(), o.lan).includes(origin),
    userFor: (who) => o.tenants.signInAs(who), userName: (id) => o.instance.users.get(id)?.name ?? id,
  });

  // Each mutation names the least role that may make it (design.md "Sign-in" Roles).
  const allow = (needs: UiRole) => ({ onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
    const r = mutationRefusal(req.headers, o.port(), o.lan, sessions, needs);
    if (r) return refuse(req, reply, r.why, r.needs);
  } });
  const operator = allow('operator');
  const admin = allow('admin');

  app.post('/ui/api/jobs/:id/cancel', operator, async (req) => o.tenant(req).engine.cancel(parseWith(idParams, req.params).id, 'cancelled in UI'));
  app.post('/ui/api/jobs/:id/approve', operator, async (req) => o.tenant(req).engine.approve(parseWith(idParams, req.params).id));

  app.post('/ui/api/questions/:id/answer', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { answer } = parseWith(answerBody, req.body);
    const r = o.tenant(req).questions.answerByHuman(id, answer);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/close', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.tenant(req).questions.closeByHuman(id);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/dismiss', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.tenant(req).questions.dismissByHuman(id);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/seen', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.tenant(req).questions.markSeen(id);
    if (r.ok) return r.question;
    throw new HttpError(404, `question ${id} not found`);
  });

  app.post('/ui/api/router-mode', admin, async (req) => {
    const t = o.tenant(req);
    t.engine.setRouterMode(parseWith(routerModeBody, req.body).mode);
    return routerView(t.engine, t.plugins);
  });

  // design.md "UI and mutation": one instance's options (never a command-bearing one), the plugin
  // filling a one-instance role, or a rescan. Answers the new GET /api/plugins report.
  app.post('/ui/api/plugins', admin, async (req) => {
    const r = await o.tenant(req).plugins.edit(parseWith(pluginsEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // design.md "Plugin store": read the store again, install (or update) a plugin it lists into the
  // plugin dir, or remove a store install. Answers the new GET /api/plugin-store report.
  app.post('/ui/api/plugin-store', admin, async (req) => {
    const r = await o.pluginStore.edit(parseWith(pluginStoreBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // Question gates (issue #18): the rules, whole, against the version read (sha-256 of the text);
  // the next question reads them. Answers the new GET /api/question-gates rules.
  app.post('/ui/api/rules', admin, async (req) => {
    const { text, version } = parseWith(rulesBody, req.body);
    const r = writeRules(o.tenant(req).store.documents, text, version);
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.view;
  });

  // Issue #18: one webhook subscription added, edited or removed (a row, issue #78). Answers the new GET /api/webhooks
  // view. No secret passes either way (issue #56): the runtime holds them.
  app.post('/ui/api/webhooks', admin, async (req) => {
    const t = o.tenant(req);
    const r = t.webhooksEditor.edit(parseWith(webhooksEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return webhooksView(t.store, t.secretProblem);
  });

  // design.md "Machines from the UI" (issues #18, #74): attach an ssh target as a new `ssh` instance
  // in plugins.yaml `machines:`; applies without a restart. Answers the new GET /api/machines/config.
  app.post('/ui/api/machines', admin, async (req) => {
    const r = await o.tenant(req).plugins.editMachines(parseWith(machinesEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.config;
  });

  // Issue #142: plugins.yaml `machineDefaults:`, what a machine attached here starts with. Answers the new GET /api/machines/config.
  app.post('/ui/api/machines/defaults', admin, async (req) => {
    const r = await o.tenant(req).plugins.editMachineDefaults(parseWith(machineDefaultsBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.config;
  });

  // design.md "Routing rules (issue #18)": the whole ordered list into plugins.yaml `routing:`.
  // Answers the new GET /api/routing report. A rule change applies to new jobs only.
  app.post('/ui/api/routing', admin, async (req) => {
    const r = await o.tenant(req).plugins.editRouting(parseWith(routingEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // design.md "Self-update": answers the new GET /api/update status. `apply` answers at once (the
  // build runs in the background; the daemon then restarts), or 409 when nothing can be applied.
  app.post('/ui/api/update', admin, async (req) => {
    const body = parseWith(updateBody, req.body);
    if (body.action === 'check') return o.updater.check();
    if (body.action === 'settings') {
      const { action: _, ...patch } = body;
      return o.updater.settings(patch);
    }
    const r = o.updater.apply();
    if (!r.ok) throw new HttpError(409, r.error);
    return r.status;
  });

  // design.md "gh login": answers the new GET /api/gh-login status — the device code once gh shows it.
  // 409 when there is no gh to log in, or it cannot log in here (a token variable set).
  app.post('/ui/api/gh-login', admin, async (req) => {
    const { action } = parseWith(ghLoginBody, req.body);
    const { ghLogin } = o.tenant(req);
    const s = action === 'start' ? await ghLogin.start() : await ghLogin.cancel();
    if (s.state === 'unavailable') throw new HttpError(409, s.reason);
    return s;
  });

  // A login code as a link per LAN name, in the fragment (never sent to a server). The links
  // share one code: it works once, and expires like any other. `keep` (issue #95): the code the
  // dialog shows comes back while it is live; once used or expired, a fresh one is minted.
  app.post('/ui/api/device-link', admin, async (req) => {
    if (!signIn.local) throw new HttpError(409, 'local sign-in is off in auth.yaml: no login code to hand on');
    if (o.lan.names.length === 0) throw new HttpError(409, 'no LAN names: set HOPPER_LAN_NAMES and HOPPER_LAN_PEERS to reach the UI from another device');
    const { keep } = parseWith(deviceLinkBody, req.body ?? {});
    // The device signs in as the session's own user (issue #158).
    const userId = sessionOf(req)!.userId;
    const code = keep !== undefined && loginCodeLive(o.instance, o.clock, keep) === userId ? keep : mintLoginCode(o.instance, o.clock, userId);
    return { links: lanHosts(o.port(), o.lan).map((h) => `http://${h}/#login=${code}`) };
  });

  // Users (issue #158, design.md "Users: one hopper, separate users"): add a user — its schema, its
  // plugins.yaml, its runtime — and answer with a one-time login link for it per UI origin, to hand over.
  app.post('/ui/api/users', admin, async (req): Promise<UserAdded> => {
    const { name } = parseWith(usersEditBody, req.body);
    if (o.tenants.list().some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `the name ${name} is taken`);
    const user = await o.tenants.add(name);
    console.warn(`hopper: user ${user.id} added by ${sessionUser(sessionOf(req)!, userName(sessionOf(req)!)).identity}`);
    const code = signIn.local ? mintLoginCode(o.instance, o.clock, user.id) : undefined;
    return {
      user: { id: user.id, name: user.name, createdAt: user.createdAt },
      links: code === undefined ? [] : uiOrigins(o.port(), o.lan).map((origin) => `${origin}/#login=${code}`),
    };
  });

  app.post('/ui/api/logout', allow('viewer'), async (req) => {
    const s = sessions.find(String(req.headers[SESSION_HEADER]));
    if (s) console.warn(`hopper: UI session ended: ${s.identity.provider} ${sessionUser(s, userName(s)).identity}`);
    sessions.drop(String(req.headers[SESSION_HEADER]));
    return { ok: true };
  });
}
