// The UI session and the only mutations left (design.md "UI session and mutations"): a one-time
// login code → POST /ui/login → a page that keeps the session token in localStorage → POST
// /ui/api/* with that token in x-jobhopper-session, exact Origin, same-origin, JSON. Every
// refusal is a logged 403.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, PluginsView, QuestionService, UiSessionRepository } from '../../domain/ports.ts';
import type { Engine } from '../../engine/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import { routerView } from '../state.ts';
import { SESSION_HEADER, mutationRefusal } from './guard.ts';
import { createLoginCode } from './login-code.ts';
import { createUiSessions } from './sessions.ts';

export { LOGIN_CODE_FILE } from './login-code.ts';

export interface UiRouteOptions {
  engine: Engine;
  questions: QuestionService;
  uiSessions: UiSessionRepository;
  plugins: PluginsView;
  /** The bound port (known only after listen). */
  port: () => number;
  dataDir: string;
  clock: Clock;
  sessionHours: number;
}

const idParams = z.object({ id: z.string() });
const answerBody = z.object({ answer: z.string().trim().min(1, 'answer must not be empty') });
const routerModeBody = z.object({ mode: z.enum(['shadow', 'active']) });
const loginBody = z.object({ code: z.string() });

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
  const sessions = createUiSessions({ repo: o.uiSessions, clock: o.clock, hours: o.sessionHours });

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
    const why = mutationRefusal(req.headers, o.port(), sessions);
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

  app.post('/ui/api/router-mode', guarded, async (req) => {
    o.engine.setRouterMode(parseWith(routerModeBody, req.body).mode);
    return routerView(o.engine, o.plugins);
  });

  app.post('/ui/api/logout', guarded, async (req) => {
    sessions.drop(String(req.headers[SESSION_HEADER]));
    return { ok: true };
  });
}
