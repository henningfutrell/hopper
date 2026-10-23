// Whose request it is (issue #158, design.md "Users: one hopper, separate users" HTTP): every tenant
// route reads and changes the runtime of the request's user — the UI session's user; else, on a read of
// /api/, the user a token in `Authorization: Bearer …` signs in as (the API door, issue #255); for a
// loopback request with neither, the one user while the hopper has only one, else nobody (401): no
// request reads another user's work (issue #221, design.md "What an admin sees"). A LAN or public request
// with neither never gets this far for /api/ (the Host guard answers 401).
//
// The API door signs nobody in: the token's identity, checked by the sign-in service as the UI door
// checks it, reads as the user it is linked to, and a GitHub realm's only as the user whose connected
// GitHub account it is. A token given and refused is refused, on loopback too. A sign-in's token reads only;
// what it may do beyond is exchange itself for an API token (issue #718, src/http/api-tokens.ts). An API token is a
// session (src/http/ui/sessions.ts) and reads as its user, once Access allows its read (`api_token#can_view`).
import type { DiscoverAnswer } from '../infra-plans/topology-discovery.ts';
import type { GitLabAccount } from '../gitlab/account.ts';
import type { Outbound } from '../outbound/index.ts';
import type { DirectJobs } from '../direct-jobs/index.ts';
import type { UserSearch } from '../search/index.ts';
import type { RuntimeSocket } from '../sandbox/socket-http.ts';
import type { Vault } from '../vault/vault.ts';
import type { JobStream } from '../job-stream/index.ts';
import type { UserArtifacts } from '../artifacts/index.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SignIn } from '../auth/index.ts';
import type { ConnectedAccounts, PluginsView, QuestionService, ReviewServices, SourceRegistry, UserStore, WebhookDispatcher } from '../domain/ports.ts';
import type { Identity, SessionKind, UiRole, User } from '../domain/types.ts';
import type { Access } from '../authz/service.ts';
import type { Engine } from '../engine/index.ts';
import type { HeavyGate } from '../engine/heavy-gate.ts';
import type { Failures } from '../failures/index.ts';
import type { Logins, SignIns } from '../logins/index.ts';
import type { JobTerminal } from '../engine/terminal.ts';
import type { MachineTerminal } from '../engine/machine-terminal.ts';
import type { MinorDecisions, TypesafeKey } from '../minor-decisions/index.ts';
import type { Tldrs } from '../tldr/index.ts';
import type { WebhooksEditor } from '../webhooks/edit.ts';
import { HttpError } from './errors.ts';
import { atApiDoor, requestSession } from './host-guard.ts';
import { apiTokenIn } from './ui/guard.ts';
import { accessIdOf, grantActionRefusal, grantScopeRefusal, senderRefusal } from './ui/api-tokens.ts';
import { grantLimitRefusal } from './ui/grant-limits.ts';
import type { DpopProofs } from './ui/dpop.ts';
import type { ApiGrants } from './ui/api-grants.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import type { UiSessions } from './ui/sessions.ts';
import type { SecretProblem } from './webhooks.ts';
import type { UserMachineLink } from '../users/runtime.ts';
import type { UserGitHubProxy } from '../users/github-proxy.ts';
import type { WindowsSteps } from '../windows-steps/index.ts';
import type { NeedSteps } from '../sandbox/need-steps.ts';
import type { Bastions } from '../sandbox/bastions.ts';
import type { SandboxRequests } from '../sandbox/requests.ts';
import type { UsageRecorder } from '../usage/history.ts';
import type { ResourceRecorder } from '../machines/history.ts';
import type { WindowsLinkWatch } from '../machines/windows-link-watch.ts';

/** One user's parts, as the HTTP edge reads and changes them. */
export interface TenantParts {
  store: UserStore;
  /** Topology discovery (issue #1781 part 3): a run a person asks for. */
  topologyDiscovery: { discover(): Promise<DiscoverAnswer | undefined> };
  engine: Engine;
  questions: QuestionService;
  /** Each review section's review: proposals (issue #537), research (issue #543). */
  reviews: ReviewServices;
  /** The levels that may review a review section's items now: the escalation levels' names (issues #537, #543). */
  levelNames(): string[];
  /** The logins a job or run waits on (issue #476). */
  logins: Logins;
  /** The tool sign-ins a person starts from Accounts (issue #1128). */
  signIns: SignIns;
  /** The job's terminal (issue #1128): a running job's pane, viewed and typed into. */
  terminal: JobTerminal;
  /** The machine's terminal (issue #1128): the panes of the hopper's herdr session on a machine, viewed and typed into. */
  machineTerminal: MachineTerminal;
  /** The failure assessor (issue #509). */
  failures: Failures;
  /** Decider calls through Jev first (issue #550). */
  minorDecisions: MinorDecisions;
  /** The TypeSafe API key Jev asks with (issue #657): its view, set and remove; never the key. */
  typesafeKey: TypesafeKey;
  /** The TL;DR of every long card (issue #569): its sweep, run at once when the setting turns on. */
  tldrs: Pick<Tldrs, 'sweep'>;
  /** Every job source's status (/api/sources, SSE source.updated). */
  registry: SourceRegistry;
  plugins: PluginsView;
  dispatcher: WebhookDispatcher;
  /** The user's outbound sends (issue #1014): the open circuits of the destinations the user sent to. */
  outbound: Pick<Outbound, 'circuits'>;
  /** The user's connected GitHub account (issue #214). */
  connectedAccounts: ConnectedAccounts;
  /** The user's GitLab account (issue #1448 part 2). */
  gitlabAccount: GitLabAccount;
  webhooksEditor: WebhooksEditor;
  /** Why a webhook subscription has no secret to sign with (issue #451); never the secret. */
  secretProblem: SecretProblem;
  /** The user's machines that dial in (issue #308). */
  machineLink: UserMachineLink;
  /** The vault (issue #558). */
  vault: Vault;
  /** The job stream (issue #613): what the user's running jobs subscribe to. */
  jobStream: JobStream;
  /** The artifacts (issue #624): what the user's jobs make for a person to see. */
  artifacts: UserArtifacts;
  /** The usage history's recorder: new usage samples (SSE usage.recorded, issue #502). */
  usageHistory: Pick<UsageRecorder, 'onRecorded'>;
  /** The resource recorder: new machine samples (SSE machine.recorded, issue #560). */
  machineHistory: Pick<ResourceRecorder, 'onRecorded'>;
  /** The Windows link (issue #712): what the keep-alive loop on Windows reports, and the last report. */
  windowsLink: Pick<WindowsLinkWatch, 'report' | 'reported'>;
  /** The GitHub proxy's view of the user (issue #563): their jobs asking, their GitHub connection. */
  githubProxy: UserGitHubProxy;
  /** Windows sandbox steps (issue #731): the user's Windows hosts, and their jobs' steps on them. */
  windowsSteps: WindowsSteps;
  /** A Podman host's ssh stream by name (issue #2272), for its status on Machines; undefined: no such host. */
  podmanHostSocket(name: string): RuntimeSocket | undefined;
  /** need steps (issue #1007): their jobs' steps in need boxes of a template that covers their needs. */
  needSteps: NeedSteps;
  /** Bastions (issue #2146): each job's one need box that outlives a step, forwarding to its targets. */
  bastions: Bastions;
  /** Direct jobs (issue #901): jobs a person submits straight to the hopper, with no GitHub issue. */
  directJobs: DirectJobs;
  /** Search (issue #945): the user's index and the permission-checked search. */
  search: UserSearch;
  /** The boxes the user's jobs ask for (issue #991). */
  sandboxRequests: SandboxRequests;
  /** The heavy-step gate (issue #2622 part 3): the slots of the hosts' memory the user's jobs' heavy steps run in. */
  heavyGate: HeavyGate;
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
/** Whether the request's session is an API token (issue #718); absent: no session. */
const kinds = new WeakMap<FastifyRequest, SessionKind>();
/** An API token's label (its grant's, issue #881): who acts, when the token is an agent's (issue #871 part 2). */
const labels = new WeakMap<FastifyRequest, string>();
/** An API token's grant (issue #881), for what a delegate approver may approve (issue #1138). */
const grantIds = new WeakMap<FastifyRequest, string>();
/** The verified email of the request's user (issue #1380), read when an act is recorded: what attribution names. */
const emails = new WeakMap<FastifyRequest, () => string | undefined>();

/** What a refused API token, or one that names no live session, is told. */
export const API_TOKEN_GONE = 'the API token is unknown, revoked or expired';

/** The API door: the user and role a sign-in's token reads as, or why not. Never given an API token: that is a session. */
export function createApiDoor(o: { tenants: Tenants; signIn: Pick<SignIn, 'checkToken'> }) {
  return async (req: FastifyRequest): Promise<{ userId: string; role: UiRole; who: Identity } | { status: number; error: string }> => {
    if (apiTokenIn(req.headers) !== undefined) return { status: 401, error: API_TOKEN_GONE };
    const r = await o.signIn.checkToken(req.headers);
    if (!r.ok) return r;
    const user = o.tenants.linked(r.who);
    // A GitHub identity reads only as the user whose connected GitHub account it is.
    const connected = r.via !== 'github' || (user !== undefined && o.tenants.user(user.id)?.store.connectedAccounts.get('github')?.subject === r.who.subject);
    if (!user || !connected) return { status: 401, error: notLinked(r.who, r.via) };
    return { userId: user.id, role: r.role, who: r.who };
  };
}

export function installTenancy(app: FastifyInstance, o: { tenants: Tenants; sessions: UiSessions; grants: Pick<ApiGrants, 'live'>; proofs: DpopProofs; signIn: Pick<SignIn, 'checkToken'>; access: Pick<Access, 'decideApiToken'>; port: () => number; lan: Lan;
  /** The field of a POST route's body that names its action (issue #909), by the route as registered; undefined: none. */
  actionField: (route: string) => string | undefined;
}): void {
  const peers = peerList(o.lan.peers);
  const throughApiDoor = createApiDoor(o);
  const emailOf = (userId: string) => (): string | undefined => o.tenants.list().find((u) => u.id === userId)?.email;
  app.addHook('onRequest', async (req, reply) => {
    const session = requestSession(req, o.sessions);
    if (session) {
      // A bound grant's API token (issue #892, "Sender binding"): on every request, a DPoP proof of its grant's key.
      if (session.kind === 'api') {
        const unproved = await senderRefusal(o.grants, o.proofs, session, req);
        if (unproved !== undefined) {
          console.warn(`hopper: API token refused for ${req.method} ${req.url.split('?')[0]}: ${unproved}`);
          return reply.code(401).header('www-authenticate', 'DPoP error="invalid_dpop_proof"').send({ error: `the API token is refused: ${unproved}` });
        }
      }
      // An API token's read: its grant's scopes (issue #881), then Access decide it (a mutation's is decided by its guard).
      // A path no route serves gets the not-found answer, never a scope refusal (issue #2229).
      if (session.kind === 'api' && req.method === 'GET' && req.url.startsWith('/api/') && req.routeOptions.url !== undefined) {
        const outOfScope = grantScopeRefusal(o.grants, session, req.method, req.routeOptions.url);
        if (outOfScope !== undefined) {
          console.warn(`hopper: API token refused for ${req.method} ${req.url.split('?')[0]}: ${outOfScope}`);
          return reply.code(403).send({ error: `the API token may not read this: ${outOfScope}` });
        }
        const d = await o.access.decideApiToken({ userId: session.userId, tokenId: accessIdOf(session), role: 'viewer' });
        if (!d.allowed) {
          console.warn(`hopper: API token refused for ${req.method} ${req.url.split('?')[0]}: ${d.reason}`);
          return reply.code(403).send({ error: `the API token may not read: ${d.reason}` });
        }
      }
      users.set(req, session.userId); roles.set(req, session.role); identities.set(req, session.identity); kinds.set(req, session.kind);
      emails.set(req, emailOf(session.userId));
      if (session.kind === 'api' && session.label !== undefined) labels.set(req, session.label);
      if (session.kind === 'api' && session.grantId !== undefined) grantIds.set(req, session.grantId);
      return;
    }
    if (atApiDoor(req)) {
      const at = await throughApiDoor(req);
      if ('error' in at) {
        console.warn(`hopper: API token refused for ${req.method} ${req.url.split('?')[0]}: ${at.error}`);
        return reply.code(at.status).send({ error: at.error });
      }
      users.set(req, at.userId);
      roles.set(req, at.role);
      identities.set(req, at.who);
      emails.set(req, emailOf(at.userId));
      return;
    }
    const r = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if (!('reach' in r) || r.reach !== 'local') return;
    const all = o.tenants.list();
    if (all.length === 1) users.set(req, all[0]!.id);
  });
  // Once the body is read, a grant's mutation: one that names one of its route's actions (issue #909) needs the grant's
  // scopes to cover that action, or the whole route (the door let the grant through on a part of the route's actions);
  // a limited grant's (issue #892, "Grant limits") must act only on the repositories and job sources it names.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' || kinds.get(req) !== 'api' || req.routeOptions.url === undefined) return;
    const session = requestSession(req, o.sessions);
    if (!session) return;
    const route = req.routeOptions.url;
    const field = route === undefined ? undefined : o.actionField(route);
    const refusal = (field === undefined ? undefined : grantActionRefusal(o.grants, session, req.method, route, (req.body as Record<string, unknown> | undefined)?.[field]))
      ?? grantLimitRefusal(o.grants, session, req, route, o.tenants.user(session.userId)?.store);
    if (refusal === undefined) return;
    console.warn(`hopper: API token refused for ${req.method} ${req.url.split('?')[0]}: ${refusal}`);
    return reply.code(403).send({ error: `the API token may not do this: ${refusal}` });
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

/**
 * The request's session or token as the instance admin check reads it (issue #240); undefined: neither. `kind`: the
 * session's (an API token's is `api`); absent for a sign-in's token on the API door. `label`: an API token's. `grantId`: its grant's.
 * `email`: the verified email its user is known by (issue #1380), what an act is recorded by (`personOf`); absent: none yet.
 */
export function signedInOf(req: FastifyRequest): { role: UiRole; identity: Identity; userId: string; email?: string; kind?: SessionKind; label?: string; grantId?: string } | undefined {
  const role = roles.get(req);
  const identity = identities.get(req);
  const userId = users.get(req);
  const kind = kinds.get(req);
  const label = labels.get(req);
  const grantId = grantIds.get(req);
  if (role === undefined || identity === undefined || userId === undefined) return undefined;
  const email = emails.get(req)?.();
  return { role, identity, userId, ...(email !== undefined ? { email } : {}), ...(kind ? { kind } : {}), ...(label !== undefined ? { label } : {}), ...(grantId !== undefined ? { grantId } : {}) };
}

const notLinked = (who: Identity, via: 'gateway' | 'github'): string => via === 'github'
  ? `the GitHub account ${who.username ?? who.subject} is no hopper user's connected GitHub account: sign in with GitHub in the UI first`
  : `the token signs in as ${who.realm} ${who.username ?? who.subject}, who has no hopper user: sign in through the UI first`;
