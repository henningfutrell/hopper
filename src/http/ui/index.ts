// The UI session and the only mutations left (design.md "UI session and mutations"): a one-time
// login code (when auth.yaml leaves local sign-in on) or an identity provider (sign-in.ts) → a page
// that keeps the session token in localStorage → POST /ui/api/* with that token in
// x-jobhopper-session, exact Origin, same-origin, JSON, and a role that allows it (design.md
// "Sign-in: local, OIDC and SAML"). Every refusal is a logged 403. A logged-in admin hands another
// device a login link per LAN name (design.md "Reaching the UI across the LAN").
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SignIn } from '../../auth/index.ts';
import type { Clock, PluginsView, QuestionService, Store, Updater } from '../../domain/ports.ts';
import { LIST_ROLES, ROLES, SELECTABLE_ROLES, UPDATE_CHANNELS, type SessionView, type UiRole } from '../../domain/types.ts';
import type { Engine } from '../../engine/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import { lanHosts, uiOrigins, type Lan } from '../reach.ts';
import { writeRules } from '../../questions/index.ts';
import { routerView } from '../state.ts';
import { webhooksView } from '../webhooks.ts';
import type { WebhookConfigView } from '../webhooks.ts';
import type { WebhooksEditor } from '../../webhooks/edit.ts';
import { SESSION_HEADER, mutationRefusal } from './guard.ts';
import { mintLoginCode } from './login-code.ts';
import { sessionUser, type UiSessions } from './sessions.ts';
import { registerSignInRoutes } from './sign-in.ts';


export interface UiRouteOptions {
  engine: Engine;
  questions: QuestionService;
  sessions: UiSessions;
  signIn: SignIn;
  plugins: PluginsView;
  /** The bound port (known only after listen). */
  port: () => number;
  lan: Lan;
  clock: Clock;
  store: Pick<Store, 'webhooks' | 'documents' | 'loginCodes'>;
  webhookConfig: WebhookConfigView;
  webhooksEditor: WebhooksEditor;
  updater: Updater;
}

const idParams = z.object({ id: z.string() });
const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
const routerModeBody = z.object({ mode: z.enum(['shadow', 'active']) });
const pluginsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('options'), role: z.enum(ROLES), name: z.string().min(1), options: z.record(z.string(), z.unknown()), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('select'), role: z.enum(SELECTABLE_ROLES), plugin: z.string().min(1).nullable(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('add'), role: z.enum(LIST_ROLES), plugin: z.string().min(1), name: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('remove'), role: z.enum(LIST_ROLES), name: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('rescan') }),
]);
const rulesBody = z.strictObject({ text: z.string(), version: z.string().min(1) });
// The content (url, events) is checked against webhooks.yaml's own schema in the editor, so the UI
// shows the file's messages; here only the shape. No secret, no secretFile, no new name.
const webhookFields = { name: z.string().min(1), version: z.string().min(1) };
const webhooksEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), ...webhookFields, url: z.string(), events: z.array(z.string()), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('edit'), ...webhookFields, url: z.string().optional(), events: z.array(z.string()).optional(), active: z.boolean().optional() }),
  z.strictObject({ action: z.literal('rotate-secret'), ...webhookFields }),
  z.strictObject({ action: z.literal('remove'), ...webhookFields }),
]);
const machineName = z.string().trim().min(1).max(64);
const machineLanes = z.number().int().min(1, 'lanes must be at least 1');
const machineExecutors = z.array(z.string().min(1));
// ssh is checked against the detected ssh targets, herdrBin and session are never accepted (strict).
const machinesEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), name: machineName, ssh: z.string().min(1), lanes: machineLanes, executors: machineExecutors.optional(), label: z.string().trim().min(1).optional(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('edit'), name: machineName, lanes: machineLanes.optional(), executors: machineExecutors.optional(), label: z.string().trim().min(1).nullable().optional(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('remove'), name: machineName, version: z.string().min(1) }),
]);
// Self-update (issue #44): check now, apply the available update, or set the channel / auto-update.
const updateBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('check') }),
  z.strictObject({ action: z.literal('apply') }),
  z.strictObject({ action: z.literal('settings'), channel: z.enum(UPDATE_CHANNELS).optional(), autoUpdate: z.boolean().optional() }),
]);
const EDIT_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
/** The rules themselves are validated by the plugin host (the plugins.yaml schema), so a refusal names the field. */
const routingEditBody = z.strictObject({ rules: z.array(z.any()), version: z.string().min(1) });

const refuse = (req: FastifyRequest, reply: FastifyReply, why: string, needs?: UiRole) => {
  console.warn(`job-hopper: UI ${req.method} ${req.url} refused: ${why}`);
  return reply.code(403).send(needs ? { error: why, needs } : { error: why });
};

export function registerUiRoutes(app: FastifyInstance, o: UiRouteOptions): void {
  const { sessions, signIn } = o;

  app.get('/ui/api/session', async (req): Promise<SessionView> => {
    const header = req.headers[SESSION_HEADER];
    const s = sessions.find(typeof header === 'string' ? header : undefined);
    const offer = { local: signIn.local, none: signIn.none, password: signIn.password, origin: signIn.origin(), providers: signIn.providers() };
    return s ? { authenticated: true, expiresAt: s.expiresAt, user: sessionUser(s), signIn: offer } : { authenticated: false, signIn: offer };
  });

  registerSignInRoutes(app, {
    sessions, signIn, refuse, store: o.store, clock: o.clock, isUiOrigin: (origin) => uiOrigins(o.port(), o.lan).includes(origin),
  });

  // Each mutation names the least role that may make it (design.md "Sign-in" Roles).
  const allow = (needs: UiRole) => ({ onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
    const r = mutationRefusal(req.headers, o.port(), o.lan, sessions, needs);
    if (r) return refuse(req, reply, r.why, r.needs);
  } });
  const operator = allow('operator');
  const admin = allow('admin');

  app.post('/ui/api/jobs/:id/cancel', operator, async (req) => o.engine.cancel(parseWith(idParams, req.params).id, 'cancelled in UI'));
  app.post('/ui/api/jobs/:id/approve', operator, async (req) => o.engine.approve(parseWith(idParams, req.params).id));

  app.post('/ui/api/questions/:id/answer', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { answer } = parseWith(answerBody, req.body);
    const r = o.questions.answerByHuman(id, answer);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/close', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.questions.closeByHuman(id);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/dismiss', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.questions.dismissByHuman(id);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/seen', operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.questions.markSeen(id);
    if (r.ok) return r.question;
    throw new HttpError(404, `question ${id} not found`);
  });

  app.post('/ui/api/router-mode', admin, async (req) => {
    o.engine.setRouterMode(parseWith(routerModeBody, req.body).mode);
    return routerView(o.engine, o.plugins);
  });

  // design.md "UI and mutation": one instance's options (never a command-bearing one), the plugin
  // filling a one-instance role, or a rescan. Answers the new GET /api/plugins report.
  app.post('/ui/api/plugins', admin, async (req) => {
    const r = await o.plugins.edit(parseWith(pluginsEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // Question gates (issue #18): the rules, whole, against the version read (sha-256 of the text);
  // the next question reads them. Answers the new GET /api/question-gates rules.
  app.post('/ui/api/rules', admin, async (req) => {
    const { text, version } = parseWith(rulesBody, req.body);
    const r = writeRules(o.store.documents, text, version);
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.view;
  });

  // Issue #18: one webhooks.yaml entry added, edited, its secret rotated, or removed. Answers the
  // new GET /api/webhooks view, plus the new secret after add or rotate-secret — the only time a
  // secret leaves the daemon.
  app.post('/ui/api/webhooks', admin, async (req) => {
    const r = o.webhooksEditor.edit(parseWith(webhooksEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return { ...webhooksView(o.store, o.webhookConfig), ...(r.secret === undefined ? {} : { secret: r.secret }) };
  });

  // design.md "Machines from the UI" (issue #18): add, edit or remove one attached machine in
  // plugins.yaml; applies without a restart. Answers the new GET /api/machines/config.
  app.post('/ui/api/machines', admin, async (req) => {
    const r = await o.plugins.editMachines(parseWith(machinesEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.config;
  });

  // design.md "Routing rules (issue #18)": the whole ordered list into plugins.yaml `routing:`.
  // Answers the new GET /api/routing report. A rule change applies to new jobs only.
  app.post('/ui/api/routing', admin, async (req) => {
    const r = await o.plugins.editRouting(parseWith(routingEditBody, req.body));
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

  // A fresh login code as a link per LAN name, in the fragment (never sent to a server). The links
  // share one code: it works once, and expires like any other.
  app.post('/ui/api/device-link', admin, async () => {
    if (!signIn.local) throw new HttpError(409, 'local sign-in is off in auth.yaml: no login code to hand on');
    if (o.lan.names.length === 0) throw new HttpError(409, 'no LAN names: set JOB_HOPPER_LAN_NAMES and JOB_HOPPER_LAN_PEERS to reach the UI from another device');
    const code = mintLoginCode(o.store, o.clock);
    return { links: lanHosts(o.port(), o.lan).map((h) => `http://${h}/#login=${code}`) };
  });

  app.post('/ui/api/logout', allow('viewer'), async (req) => {
    const s = sessions.find(String(req.headers[SESSION_HEADER]));
    if (s) console.warn(`job-hopper: UI session ended: ${s.identity.provider} ${sessionUser(s).name}`);
    sessions.drop(String(req.headers[SESSION_HEADER]));
    return { ok: true };
  });
}
