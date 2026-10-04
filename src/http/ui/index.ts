// The UI session and the only mutations left (design.md "UI session and mutations"): a one-time
// login code → POST /ui/login → a page that keeps the session token in localStorage → POST
// /ui/api/* with that token in x-jobhopper-session, exact Origin, same-origin, JSON. Every
// refusal is a logged 403. A logged-in browser hands another device a login link per LAN name
// (design.md "Reaching the UI across the LAN").
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PluginsView, QuestionService, Store } from '../../domain/ports.ts';
import { LIST_ROLES, ROLES, SELECTABLE_ROLES } from '../../domain/types.ts';
import type { Engine } from '../../engine/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import { lanHosts, type Lan } from '../reach.ts';
import { writeRulesFile } from '../../questions/index.ts';
import { routerView } from '../state.ts';
import { webhooksView } from '../webhooks.ts';
import type { WebhookConfigView } from '../webhooks.ts';
import type { WebhooksEditor } from '../../webhooks/edit.ts';
import { SESSION_HEADER, mutationRefusal } from './guard.ts';
import { createLoginCode } from './login-code.ts';
import type { UiSessions } from './sessions.ts';

export { LOGIN_CODE_FILE } from './login-code.ts';

export interface UiRouteOptions {
  engine: Engine;
  questions: QuestionService;
  sessions: UiSessions;
  plugins: PluginsView;
  /** The rules file (JOB_HOPPER_RULES_FILE). */
  rulesFile: string;
  /** The bound port (known only after listen). */
  port: () => number;
  lan: Lan;
  dataDir: string;
  store: Pick<Store, 'webhooks'>;
  webhookConfig: WebhookConfigView;
  webhooksEditor: WebhooksEditor;
}

const idParams = z.object({ id: z.string() });
const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
const routerModeBody = z.object({ mode: z.enum(['shadow', 'active']) });
const loginBody = z.object({ code: z.string() });
const pluginsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('options'), role: z.enum(ROLES), name: z.string().min(1), options: z.record(z.string(), z.unknown()), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('select'), role: z.enum(SELECTABLE_ROLES), plugin: z.string().min(1).nullable(), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('add'), role: z.enum(LIST_ROLES), plugin: z.string().min(1), name: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('remove'), role: z.enum(LIST_ROLES), name: z.string().min(1), version: z.string().min(1) }),
  z.strictObject({ action: z.literal('rescan') }),
]);
const rulesFileBody = z.strictObject({ text: z.string(), version: z.string().min(1) });
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
const EDIT_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;
/** The rules themselves are validated by the plugin host (the plugins.yaml schema), so a refusal names the field. */
const routingEditBody = z.strictObject({ rules: z.array(z.any()), version: z.string().min(1) });

const refuse = (req: FastifyRequest, reply: FastifyReply, why: string) => {
  console.warn(`job-hopper: UI ${req.method} ${req.url} refused: ${why}`);
  return reply.code(403).send({ error: why });
};

/** The login answer: store the token (hex, safe inline) for this exact origin, then go to the UI. */
const loginPage = (token: string): string => `<!doctype html><meta charset="utf-8"><title>job-hopper</title>
<script>try { localStorage.setItem('jh_session', '${token}'); } catch (e) {} location.replace('/');</script>
<noscript>JavaScript is needed to keep the UI session.</noscript>
`;

export function registerUiRoutes(app: FastifyInstance, o: UiRouteOptions): void {
  const code = createLoginCode(o.dataDir);
  code.rotate();
  const { sessions } = o;

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  // Origin may be null (a local file posts it); the code is the credential.
  app.post('/ui/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success || !code.use(parsed.data.code)) return refuse(req, reply, 'wrong or missing login code');
    const s = sessions.create();
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .send(loginPage(s.token));
  });

  app.get('/ui/api/session', async (req) => {
    const header = req.headers[SESSION_HEADER];
    const s = sessions.find(typeof header === 'string' ? header : undefined);
    return s ? { authenticated: true, expiresAt: s.expiresAt } : { authenticated: false };
  });

  const guarded = { onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
    const why = mutationRefusal(req.headers, o.port(), o.lan, sessions);
    if (why) return refuse(req, reply, why);
  } };

  app.post('/ui/api/jobs/:id/cancel', guarded, async (req) => o.engine.cancel(parseWith(idParams, req.params).id, 'cancelled in UI'));
  app.post('/ui/api/jobs/:id/approve', guarded, async (req) => o.engine.approve(parseWith(idParams, req.params).id));

  app.post('/ui/api/questions/:id/answer', guarded, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { answer } = parseWith(answerBody, req.body);
    const r = o.questions.answerByHuman(id, answer);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/questions/:id/close', guarded, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const r = o.questions.closeByHuman(id);
    if (r.ok) return r.question;
    if (r.reason === 'not_found') throw new HttpError(404, `question ${id} not found`);
    throw new HttpError(409, `question ${id} is not open`);
  });

  app.post('/ui/api/router-mode', guarded, async (req) => {
    o.engine.setRouterMode(parseWith(routerModeBody, req.body).mode);
    return routerView(o.engine, o.plugins);
  });

  // design.md "UI and mutation": one instance's options (never a command-bearing one), the plugin
  // filling a one-instance role, or a rescan. Answers the new GET /api/plugins report.
  app.post('/ui/api/plugins', guarded, async (req) => {
    const r = await o.plugins.edit(parseWith(pluginsEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // Question gates (issue #18): the rules file, whole, against the version read (sha-256 of its
  // bytes); the next question reads it. Answers the new GET /api/question-gates rulesFile.
  app.post('/ui/api/rules-file', guarded, async (req) => {
    const { text, version } = parseWith(rulesFileBody, req.body);
    const r = writeRulesFile(o.rulesFile, text, version);
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.view;
  });

  // Issue #18: one webhooks.yaml entry added, edited, its secret rotated, or removed. Answers the
  // new GET /api/webhooks view, plus the new secret after add or rotate-secret — the only time a
  // secret leaves the daemon.
  app.post('/ui/api/webhooks', guarded, async (req) => {
    const r = o.webhooksEditor.edit(parseWith(webhooksEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return { ...webhooksView(o.store, o.webhookConfig), ...(r.secret === undefined ? {} : { secret: r.secret }) };
  });

  // design.md "Machines from the UI" (issue #18): add, edit or remove one attached machine in
  // plugins.yaml; applies without a restart. Answers the new GET /api/machines/config.
  app.post('/ui/api/machines', guarded, async (req) => {
    const r = await o.plugins.editMachines(parseWith(machinesEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.config;
  });

  // design.md "Routing rules (issue #18)": the whole ordered list into plugins.yaml `routing:`.
  // Answers the new GET /api/routing report. A rule change applies to new jobs only.
  app.post('/ui/api/routing', guarded, async (req) => {
    const r = await o.plugins.editRouting(parseWith(routingEditBody, req.body));
    if (!r.ok) throw new HttpError(EDIT_STATUS[r.code], r.error);
    return r.report;
  });

  // The current login code as a link per LAN name, in the fragment (never sent to a server). It
  // works once, like the code file; using either rotates both.
  app.post('/ui/api/device-link', guarded, async () => {
    if (o.lan.names.length === 0) throw new HttpError(409, 'no LAN names: set JOB_HOPPER_LAN_NAMES and JOB_HOPPER_LAN_PEERS to reach the UI from another device');
    return { links: lanHosts(o.port(), o.lan).map((h) => `http://${h}/#login=${code.current()}`) };
  });

  app.post('/ui/api/logout', guarded, async (req) => {
    sessions.drop(String(req.headers[SESSION_HEADER]));
    return { ok: true };
  });
}
