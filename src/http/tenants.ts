// Whose request it is (issue #158, design.md "Users: one hopper, separate users" HTTP): every tenant
// route reads and changes the runtime of the request's user — the UI session's user; else, on a read of
// /api/, the user a token in `Authorization: Bearer …` signs in as (the API door, issue #255); for a
// loopback request with neither, the one user while the hopper has only one, else nobody (401): no
// request reads another user's work (issue #221, design.md "What an admin sees"). A LAN or public request
// with neither never gets this far for /api/ (the Host guard answers 401).
//
// The API door signs nobody in: the token's identity, checked by the sign-in service as the UI door
// checks it, reads as the user it is linked to, and a GitHub realm's only as the user whose connected
// GitHub account it is. A token given and refused is refused, on loopback too. A token reads only: every
// mutation stays behind a UI session (src/http/ui/guard.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SignIn } from '../auth/index.ts';
import type { ConnectedAccounts, PluginsView, QuestionService, SourceRegistry, UserStore, WebhookDispatcher } from '../domain/ports.ts';
import type { Identity, UiRole, User } from '../domain/types.ts';
import type { Engine } from '../engine/index.ts';
import type { Logins } from '../logins/index.ts';
import type { WebhooksEditor } from '../webhooks/edit.ts';
import { HttpError } from './errors.ts';
import { atApiDoor, sessionToken } from './host-guard.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import type { UiSessions } from './ui/sessions.ts';
import type { SecretProblem } from './webhooks.ts';
import type { UserMachineLink } from '../users/runtime.ts';

/** One user's parts, as the HTTP edge reads and changes them. */
export interface TenantParts {
  store: UserStore;
  engine: Engine;
  questions: QuestionService;
  /** The logins a job or run waits on (issue #476). */
  logins: Logins;
  /** Every job source's status (/api/sources, SSE source.updated). */
  registry: SourceRegistry;
  plugins: PluginsView;
  dispatcher: WebhookDispatcher;
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccounts;
  webhooksEditor: WebhooksEditor;
  /** Why a webhook subscription has no secret to sign with (issue #451); never the secret. */
  secretProblem: SecretProblem;
  /** The user's machines that dial in (issue #308). */
  machineLink: UserMachineLink;
}

/** The users and their running parts. */
export interface Tenants {
  /** A running user's parts; undefined for an unknown user (or one whose runtime has not started). */
  user(id: string): TenantParts | undefined;
  list(): User[];
  /** A new user under a unique name (throws when it is taken), its runtime started. */
  add(name: string): Promise<User>;
  /** The user an identity signs in as: linked, or new (its runtime started). */
  signInAs(who: Identity): Promise<User>;
  /** The user an identity is linked to; undefined: none (the API door signs nobody new in). */
  linked(who: Identity): User | undefined;
}

/** The request's user id, set by the hook below; read by `tenantOf`. */
const users = new WeakMap<FastifyRequest, string>();
/** The role of the request's session or token; absent: neither (loopback reads without). */
const roles = new WeakMap<FastifyRequest, UiRole>();
/** Who signed in, for the request's session or token: what the instance admin check reads (issue #240). */
const identities = new WeakMap<FastifyRequest, Identity>();

export function installTenancy(app: FastifyInstance, o: { tenants: Tenants; sessions: UiSessions; signIn: Pick<SignIn, 'checkToken'>; port: () => number; lan: Lan }): void {
  const peers = peerList(o.lan.peers);
  /** The API door: the user and role the token reads as, or why not. */
  const throughApiDoor = async (req: FastifyRequest): Promise<{ userId: string; role: UiRole; who: Identity } | { status: number; error: string }> => {
    const r = await o.signIn.checkToken(req.headers);
    if (!r.ok) return r;
    const user = o.tenants.linked(r.who);
    // A GitHub identity reads only as the user whose connected GitHub account it is.
    const connected = r.via !== 'github' || (user !== undefined && o.tenants.user(user.id)?.store.connectedAccounts.get('github')?.subject === r.who.subject);
    if (!user || !connected) return { status: 401, error: notLinked(r.who, r.via) };
    return { userId: user.id, role: r.role, who: r.who };
  };
  app.addHook('onRequest', async (req, reply) => {
    const session = o.sessions.find(sessionToken(req));
    if (session) { users.set(req, session.userId); roles.set(req, session.role); identities.set(req, session.identity); return; }
    if (atApiDoor(req)) {
      const at = await throughApiDoor(req);
      if ('error' in at) {
        console.warn(`hopper: API token refused for ${req.method} ${req.url.split('?')[0]}: ${at.error}`);
        return reply.code(at.status).send({ error: at.error });
      }
      users.set(req, at.userId);
      roles.set(req, at.role);
      identities.set(req, at.who);
      return;
    }
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

/** The role of the request's session or token (after `installTenancy`); undefined: neither. */
export const roleOfRequest = (req: FastifyRequest): UiRole | undefined => roles.get(req);

/** The request's session or token as the instance admin check reads it (issue #240); undefined: neither. */
export function signedInOf(req: FastifyRequest): { role: UiRole; identity: Identity; userId: string } | undefined {
  const role = roles.get(req);
  const identity = identities.get(req);
  const userId = users.get(req);
  return role === undefined || identity === undefined || userId === undefined ? undefined : { role, identity, userId };
}

const notLinked = (who: Identity, via: 'gateway' | 'github'): string => via === 'github'
  ? `the GitHub account ${who.username ?? who.subject} is no hopper user's connected GitHub account: sign in with GitHub in the UI first`
  : `the token signs in as ${who.realm} ${who.username ?? who.subject}, who has no hopper user: sign in through the UI first`;
