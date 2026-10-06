// Whose request it is (issue #158, design.md "Users: one hopper, separate users" HTTP): every tenant
// route reads and changes the runtime of the request's user — the UI session's user; for a loopback
// request without a session, the one user while the hopper has only one, else nobody (401): no request
// reads another user's work (issue #221, design.md "What an admin sees"). A LAN or public request
// without a session never gets this far for /api/ (the Host guard answers 401).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ConnectedAccounts, GhLogin, PluginsView, QuestionService, SourceRegistry, UserStore, WebhookDispatcher } from '../domain/ports.ts';
import type { Identity, User } from '../domain/types.ts';
import type { Engine } from '../engine/index.ts';
import type { WebhooksEditor } from '../webhooks/edit.ts';
import { HttpError } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import type { UiSessions } from './ui/sessions.ts';
import type { SecretProblem } from './webhooks.ts';

/** One user's parts, as the HTTP edge reads and changes them. */
export interface TenantParts {
  store: UserStore;
  engine: Engine;
  questions: QuestionService;
  /** Every job source's status (/api/sources, SSE source.updated). */
  registry: SourceRegistry;
  plugins: PluginsView;
  dispatcher: WebhookDispatcher;
  ghLogin: GhLogin;
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccounts;
  webhooksEditor: WebhooksEditor;
  /** Why the user's runtime gives no secret for a webhook subscription's variable. */
  secretProblem: SecretProblem;
}

/** The users and their running parts. */
export interface Tenants {
  /** A running user's parts; undefined for an unknown user (or one whose runtime has not started). */
  user(id: string): TenantParts | undefined;
  list(): User[];
  /** A new user under a unique name (throws when it is taken), its runtime started. */
  add(name: string): Promise<User>;
  /** The user an identity signs in as: linked, admin for no sign-in, or new (its runtime started). */
  signInAs(who: Identity): Promise<User>;
}

/** The request's user id, set by the hook below; read by `tenantOf`. */
const users = new WeakMap<FastifyRequest, string>();

export function installTenancy(app: FastifyInstance, o: { tenants: Tenants; sessions: UiSessions; port: () => number; lan: Lan }): void {
  const peers = peerList(o.lan.peers);
  app.addHook('onRequest', async (req) => {
    const session = o.sessions.find(sessionToken(req));
    if (session) { users.set(req, session.userId); return; }
    const r = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if (!('reach' in r) || r.reach !== 'local') return;
    const all = o.tenants.list();
    if (all.length === 1) users.set(req, all[0]!.id);
  });
}

/** The request's user's parts: 401 without a user, 404 for an unknown one. */
export function tenantOf(tenants: Tenants, req: FastifyRequest): TenantParts {
  const id = users.get(req);
  if (id === undefined) throw new HttpError(401, 'sign in to read: a user\'s work is read only with a session of that user');
  const parts = tenants.user(id);
  if (!parts) throw new HttpError(404, `no user ${id}`);
  return parts;
}

/** The request's user id (after `installTenancy`), or undefined. */
export const userIdOf = (req: FastifyRequest): string | undefined => users.get(req);
