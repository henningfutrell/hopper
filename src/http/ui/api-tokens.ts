// API tokens (issue #718, design.md "API tokens"): everything a person does in the UI, an agent does over the API with a
// short-lived token scoped to what its user may do. An API token lives minutes (the admin's setting, issue #881),
// acts with a role no higher than its minter's, never mints another, and Access decides each use. Only its hash is kept
// (a session row of kind `api`). Two ways to one:
// - a **grant** (issue #881, ./api-grants.ts), which a person mints once from their UI session for an agent: a label, a
//   holder, scopes, a box flag. The agent trades its refresh token for an API token at POST /ui/auth/token/refresh, each
//   time with a new refresh token; the grant's scopes name the routes its tokens may use, deny by default. A grant with
//   the box flag is the only kind whose tokens may do a box action (./box-actions.ts).
// - the **exchange**: an agent with no UI session trades a sign-in the API door accepts — a gateway realm's JWT, a GitHub
//   token of the user's connected account — for one API token, as the user it is linked to. Never a box token.
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  API_TOKEN_MINUTES, ACCESS_UNAVAILABLE, GRANT_DEFAULT_DAYS, GRANT_IDLE_DAYS, GRANT_MAX_DAYS, REFRESH_TOKEN_PREFIX, UI_ROLES, roleAllows,
  type AccessAnswer, type ApiGrantMinted, type ApiGrantView, type ApiTokenMinted, type ApiTokenSettings, type ApiTokenView, type Identity, type UiRole,
} from '../../domain/types.ts';
import { scopeAllows, scopeAllowsSome, scopeOfAction, scopeOfRoute, scopeProblem } from '../../domain/token-scopes.ts';
import { presetOf, scopesOf, type ScopeRegistry } from '../../domain/scope-registry.ts';
import { DELEGATE_PRESET, DENY_ENTRY_MAX, DENY_MAX, denyProblem } from '../../domain/delegates.ts';
import type { Access } from '../../authz/service.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { createApiDoor, userIdOf, type Tenants } from '../tenants.ts';
import type { SignIn } from '../../auth/index.ts';
import type { ApiGrants } from './api-grants.ts';
import { apiTokenIdOf, type UiSession, type UiSessions } from './sessions.ts';
import { SIGN_IN_RATE, signInLimit, type CallerOf } from './sign-in.ts';
import { NOT_A_BOX_TOKEN } from './box-actions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const label = z.string().trim().min(1).max(64);
const role = z.enum(UI_ROLES).optional();
const minutes = z.number().int().min(API_TOKEN_MINUTES.min).max(API_TOKEN_MINUTES.max).optional();
const id = z.string().regex(/^[0-9a-f]{16}$/, 'an id: 16 hex digits');
export const apiTokenBody = z.discriminatedUnion('action', [
  // A grant (issue #881): `box` makes its tokens box tokens (issue #795); `days` null: no fixed end, an admin's only.
  z.strictObject({
    action: z.literal('mint'), label, role, minutes,
    holder: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'a holder: lower case letters, digits, . _ -, at most 64').optional(),
    // Scopes, or a preset (issue #909: GET /api/scopes names them), or both: the grant holds the preset's and these.
    scopes: z.array(z.string().trim()).max(64).optional(),
    preset: z.string().trim().max(64).optional(),
    box: z.boolean().optional(),
    days: z.number().int().min(1).max(GRANT_MAX_DAYS).nullable().optional(),
    // A delegate approver's approver policy (issue #1138): what it may never approve.
    deny: z.array(z.string().max(DENY_ENTRY_MAX)).max(DENY_MAX).optional(),
  }),
  // A grant's id, or an exchanged token's.
  z.strictObject({ action: z.literal('revoke'), id }),
  z.strictObject({ action: z.literal('revoke-all') }),
]);
export const apiTokenExchangeBody = z.strictObject({ label, role, minutes });
export const apiTokenSettingsBody = z.strictObject({ tokenMinutes: z.number().int().min(API_TOKEN_MINUTES.min).max(API_TOKEN_MINUTES.max) });
export const tokenRefreshBody = z.strictObject({ refresh: z.string().startsWith(REFRESH_TOKEN_PREFIX, `a refresh token: ${REFRESH_TOKEN_PREFIX}…`).max(128) });

const LIFETIME = `the admin's API-token lifetime (Settings → API tokens: ${API_TOKEN_MINUTES.min}–${API_TOKEN_MINUTES.max} minutes, default ${API_TOKEN_MINUTES.default}), or less (\`minutes\`)`;
const USE = 'Send it as `Authorization: Bearer <token>` on any `GET /api/*` or `POST /ui/api/*` route: it acts as a UI session of its user with its role would, with no Origin needed, and Access (`api_token#can_view`, `can_operate` or `can_administer`, for the role the route needs) decides each use. A box action (issue #795: a route that starts a job, runs a command, approves or merges work, updates the hopper or a client, or changes the work on a machine; the list is `src/http/ui/box-actions.ts`) needs a box token and `api_token#can_run_on_box` too: any other token gets 403.';
const SCOPES = 'A grant\'s token may use only the routes its `scopes` cover (issue #881): a read `GET /api/<area>/…` needs `<area>:read`, a mutation `POST /ui/api/<area>/…/<act>` needs `<area>:<act>` (`<area>:edit` for `POST /ui/api/<area>`); a scope is `<area>:<act>`, `<area>:*`, `*:<act>` or `*`. A route whose body names one of several actions (`action`, or `kind`) has a scope for each too (issue #909): `<area>:<act>.<action>`, e.g. `vault:edit.approve-template`; the route\'s scope covers them all. `preset` (issue #909) names a preset of `GET /api/scopes`: the grant holds its scopes and `scopes`, and is a box grant when the preset is and `box` is not given. 400 for a scope that covers no route, or a preset that is not there; at least one scope.';

export const API_TOKEN_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/api-tokens', tag: 'API tokens', summary: 'List grants and API tokens', description: 'The request\'s user\'s live grants (issue #881: id, label, holder, role, scopes, box, created, fixed end or none, idle end, last used and from where) and the live API tokens an exchange made (issue #718); never a token. `scopes`: every scope a route needs. `settings`: the API-token lifetime and its bounds.', returns: '`{ grants: ApiGrantView[], tokens: ApiTokenView[], scopes: string[], settings: ApiTokenSettings }`' },
  { method: 'post', path: '/ui/api/api-tokens', tag: 'API tokens', summary: 'Mint or revoke a grant', description: `\`mint\` (issue #881): a new grant for the session's user, for an agent: a \`label\`, a \`holder\` (who keeps it, e.g. \`grok-bot\`), \`scopes\`, a \`role\` no higher than the session's (default: the session's), \`days\` it lives at most (1–${GRANT_MAX_DAYS}, default ${GRANT_DEFAULT_DAYS}; \`null\`: no fixed end, an admin's only, answered with a \`warning\`), and API tokens that live ${LIFETIME}. It dies ${GRANT_IDLE_DAYS} days after its last refresh too. \`preset: "${DELEGATE_PRESET}"\` (issue #1138) mints a **delegate approver**: it approves, declines or denies only what waits for a person — a vault grant ask, a template, a sandbox request — with its preset's scopes alone (400 with \`scopes\`), and \`deny\` is its approver policy: entries (at most ${DENY_MAX}) it may never approve, each matched in any case against every name an approval touches (the template, its secrets and assets, the machine), e.g. \`prod\`; 400 for \`deny\` on any other grant. Its approvals record \`by\` as \`<label> (delegate of <person>)\`. \`box: true\` (issue #795) makes its tokens box tokens, the only kind that may do a box action — refused (403) when Access does not allow \`api_token#can_run_on_box\`. Answers the grant (\`view\`), its first API token (\`token\`, \`expiresAt\`) and its refresh token (\`refresh\`): once, never again; not cached. The agent trades the refresh token at \`POST /ui/auth/token/refresh\`. ${SCOPES} ${USE} An API token may not mint one (403). \`revoke\`: end one of the user's grants, or an exchanged token, by its id (404 when there is none); \`revoke-all\`: every grant and API token of the user. Both answer what is left. 503 when OpenFGA cannot be asked.`, role: 'viewer', body: apiTokenBody, returns: 'mint: `ApiGrantMinted`; revoke: `{ grants: ApiGrantView[], tokens: ApiTokenView[] }`', errors: [400, 403, 404, 503] },
  { method: 'get', path: '/api/scopes', tag: 'API tokens', summary: 'The scope registry: every scope a grant may hold, and the presets', description: 'Issue #909: `sections`, one per area of work (Jobs, Intake, Questions and reviews, Pull requests, Infra changes, Vault and credentials, Machines, …), in order, each with its `permissions`: a `scope`, its plain `description`, the `routes` it covers, the least UI `role` they need, and `box` when one is a box action (only a box grant may use it). Built from the routes, so a new route\'s scope is listed with no edit; an area no section names is under `other`. `presets`: named scope sets (`id`, `label`, `description`, `scopes`, `box`) a person picks with one click, or names at the mint (`preset`).', returns: '`ScopeRegistry`' },
  { method: 'post', path: '/ui/api/api-tokens/settings', tag: 'API tokens', summary: 'Set the API-token lifetime', description: `Only the instance admin (issue #881): \`tokenMinutes\`, ${API_TOKEN_MINUTES.min}–${API_TOKEN_MINUTES.max} (default ${API_TOKEN_MINUTES.default}). Applies to the API tokens issued after it; those there are keep their own ends. A grant that asked for more gets the setting. A change is \`api_tokens.settings_changed\`.`, role: 'admin', body: apiTokenSettingsBody, returns: '`ApiTokenSettings`', errors: [400] },
  { method: 'post', path: '/ui/auth/token/refresh', tag: 'API tokens', summary: 'Trade a refresh token for an API token', description: `For the agent a grant was minted for (issue #881): \`{ refresh }\` answers a new API token (\`token\`, \`expiresAt\`) and a new refresh token (\`refresh\`), which replaces the one sent: keep it, the old one is spent. A refresh retried within 30 seconds gets the same pair. A spent refresh token sent again after that ends its whole grant at once (it may be stolen): \`api_grant.reuse_detected\`. 401 when the refresh token is unknown, spent, or its grant ended or was revoked; 429 past ${SIGN_IN_RATE} refreshes a minute from one caller. Not cached.`, body: tokenRefreshBody, returns: '`ApiTokenRefreshed`', errors: [400, 401, 429] },
  { method: 'post', path: '/ui/auth/api-token', tag: 'API tokens', summary: 'Exchange a sign-in for an API token', description: `For an agent with no UI session (issue #718): \`Authorization: Bearer <a gateway realm's JWT, or a GitHub token>\`, checked as the API door checks it, mints an API token for the user the sign-in is linked to (a GitHub account: the user whose connected account it is), with a \`label\`, a \`role\` no higher than the one the sign-in config grants (default: that one), living ${LIFETIME}. ${USE} 401 when the sign-in is refused or names no hopper user (the door signs nobody new in), or is itself an API token; never a box token and never a grant: \`box\` is refused (400); 403 when no role is granted or Access refuses; 503 when OpenFGA cannot be asked; 429 past ${SIGN_IN_RATE} exchanges a minute from one caller (behind the tunnel: the caller its edge names). Not cached.`, body: apiTokenExchangeBody, returns: '`ApiTokenMinted`', errors: [400, 401, 403, 429, 502, 503] },
];

const MINT_REFUSED = 'an API token may not mint a grant: a person mints one from the UI, or an agent exchanges its sign-in at POST /ui/auth/api-token';

/** The id Access knows an API token by: its grant's (issue #881), else the start of its hash. */
export const accessIdOf = (s: Pick<UiSession, 'token' | 'grantId'>): string => s.grantId ?? apiTokenIdOf(s.token);

/**
 * Access's answer for a use of the API token `s` with `role` (issue #718) and, for a box action, `can_run_on_box` too
 * (issue #795). A grant's token outside its scopes, and a token that is no box token at a box action, are refused
 * without asking.
 */
export async function apiTokenAnswer(
  access: Pick<Access, 'decideApiToken' | 'decideBoxAction'>, s: Pick<UiSession, 'userId' | 'token' | 'box' | 'grantId'>, role: UiRole, boxAction: boolean,
  /** The route the token is used on, checked against its grant's scopes first (issue #881); absent: a mint. */
  at?: { grants: Pick<ApiGrants, 'live'>; method: string; route: string | undefined },
): Promise<AccessAnswer> {
  const outOfScope = at && grantScopeRefusal(at.grants, s, at.method, at.route);
  if (outOfScope !== undefined) return { allowed: false, reason: outOfScope };
  if (boxAction && !s.box) return { allowed: false, reason: NOT_A_BOX_TOKEN };
  const ask = { userId: s.userId, tokenId: accessIdOf(s) };
  const d = await access.decideApiToken({ ...ask, role });
  return d.allowed && boxAction ? access.decideBoxAction({ ...ask, box: true }) : d;
}

/**
 * Why a grant's API token may not use the route (issue #881), or undefined: it may, or it is no grant's. Deny by
 * default: a route that names no scope, or one the grant's scopes do not cover, is refused; so is any route once the
 * grant ended. At the door the body is not read yet: a grant that holds only some of the route's actions' scopes (issue
 * #909) passes here, and `grantActionRefusal` checks the action the body names.
 */
export function grantScopeRefusal(grants: Pick<ApiGrants, 'live'>, s: Pick<UiSession, 'grantId'>, method: string, route: string | undefined): string | undefined {
  if (s.grantId === undefined) return undefined;
  const g = grants.live(s.grantId);
  if (!g) return 'its grant ended or was revoked';
  const needs = route === undefined ? undefined : scopeOfRoute(method, route);
  if (needs === undefined) return 'this route takes no scope: a grant\'s token may not use it';
  return scopeAllowsSome(g.scopes, needs) ? undefined : `its grant's scopes do not cover ${needs}`;
}

/**
 * Why a grant's API token may not do what the body asks of the route (issue #909), or undefined: it may, or it is no
 * grant's. `action`: what the body's action field names; absent or not a string: the route's own scope is needed.
 */
export function grantActionRefusal(grants: Pick<ApiGrants, 'live'>, s: Pick<UiSession, 'grantId'>, method: string, route: string | undefined, action: unknown): string | undefined {
  if (s.grantId === undefined) return undefined;
  const g = grants.live(s.grantId);
  if (!g) return 'its grant ended or was revoked';
  const scope = route === undefined ? undefined : scopeOfRoute(method, route);
  if (scope === undefined) return 'this route takes no scope: a grant\'s token may not use it';
  const needs = typeof action === 'string' && action !== '' ? scopeOfAction(scope, action) : scope;
  return scopeAllows(g.scopes, needs) ? undefined : `its grant's scopes do not cover ${needs}`;
}

export function registerApiTokenRoutes(app: FastifyInstance, o: {
  allow: (needs: UiRole) => Guard; instance: Guard; sessions: UiSessions; grants: ApiGrants; sessionOf: (req: FastifyRequest) => UiSession | undefined;
  access: Pick<Access, 'decideApiToken' | 'decideBoxAction'>; tenants: Tenants; signIn: Pick<SignIn, 'checkToken'>; caller: CallerOf;
  /** The scope registry (issue #909): every scope a route needs, what a grant's scopes are checked against, and the presets. */
  registry: ScopeRegistry;
}): void {
  const apiDoor = createApiDoor(o);
  const known = scopesOf(o.registry);

  const checkedMinutes = (m: number | undefined): number | undefined => {
    const most = o.grants.settings().tokenMinutes;
    if (m !== undefined && m > most) throw new HttpError(400, `minutes ${m}: an API token lives at most ${most} minutes (the admin's setting)`);
    return m;
  };

  /** A token for `userId` from an exchange, as `identity`, its role at most `most`; Access must allow that role, or it is dropped again. */
  async function exchanged(userId: string, identity: Identity, most: UiRole, want: z.output<typeof apiTokenExchangeBody>): Promise<ApiTokenMinted> {
    const role = want.role ?? most;
    if (!roleAllows(most, role)) throw new HttpError(403, `an API token may not act above its minter: ${role} is above ${most}`);
    const minutes = checkedMinutes(want.minutes) ?? o.grants.settings().tokenMinutes;
    const s = o.sessions.create({ role, identity, userId, lastsMs: minutes * 60_000, api: { label: want.label } });
    const tokenId = apiTokenIdOf(s.token);
    const d = await apiTokenAnswer(o.access, s, role, false);
    if (!d.allowed) {
      o.sessions.revokeApiToken(userId, tokenId);
      if (d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      throw new HttpError(403, `no API token is minted: ${d.reason}`);
    }
    console.warn(`hopper: API token ${tokenId} (${want.label}) minted for user ${userId} by exchange, role ${role}, ${minutes} minutes`);
    const view = o.sessions.apiTokens(userId).find((t) => t.id === tokenId)!;
    return { ...view, token: s.token };
  }

  /** A new grant for the session's user; Access must allow its role (and its box flag), or it is ended again. */
  async function grant(s: UiSession, want: Extract<z.output<typeof apiTokenBody>, { action: 'mint' }>, from: string): Promise<ApiGrantMinted> {
    const role = want.role ?? s.role;
    if (!roleAllows(s.role, role)) throw new HttpError(403, `a grant may not act above its minter: ${role} is above ${s.role}`);
    const preset = want.preset === undefined ? undefined : presetOf(o.registry, want.preset);
    if (want.preset !== undefined && !preset) throw new HttpError(400, `no preset ${JSON.stringify(want.preset)}: GET /api/scopes lists the presets (${o.registry.presets.map((p) => p.id).join(', ')})`);
    // A delegate approver (issue #1138) holds its preset's scopes only, so it approves and changes nothing else.
    const delegate = preset?.id === DELEGATE_PRESET;
    if (delegate && want.scopes?.length) throw new HttpError(400, `a delegate approver holds its preset's scopes only: mint it with no \`scopes\``);
    if (!delegate && want.deny !== undefined) throw new HttpError(400, `\`deny\` is a delegate approver's approver policy: mint with the preset ${DELEGATE_PRESET}`);
    const deny = (want.deny ?? []).map((d) => d.trim());
    const denied = denyProblem(deny);
    if (denied) throw new HttpError(400, denied);
    const scopes = [...new Set([...(preset?.scopes ?? []), ...(want.scopes ?? [])])];
    if (scopes.length === 0) throw new HttpError(400, 'name at least one scope, or a preset');
    const problems = scopes.map((p) => scopeProblem(p, known)).filter((p): p is string => p !== undefined);
    if (problems.length) throw new HttpError(400, problems.join('; '));
    if (want.days === null && !roleAllows(s.role, 'admin')) throw new HttpError(403, 'only an admin mints a grant with no fixed end: name `days`');
    const box = want.box ?? preset?.box ?? false;
    const { session, ...minted } = o.grants.mint({
      userId: s.userId, identity: s.identity, role, label: want.label, ...(want.holder === undefined ? {} : { holder: want.holder }), scopes, box,
      days: want.days === undefined ? GRANT_DEFAULT_DAYS : want.days, ...(want.minutes === undefined ? {} : { minutes: checkedMinutes(want.minutes) }),
      ...(delegate ? { delegate: { deny: [...new Set(deny)] } } : {}),
    }, from);
    const d = await apiTokenAnswer(o.access, session, role, box);
    if (!d.allowed) {
      o.grants.revoke(s.userId, minted.grant, 'refused');
      if (d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      throw new HttpError(403, `no grant is minted: ${d.reason}`);
    }
    console.warn(`hopper: grant ${minted.grant} (${want.label}${want.holder ? `, held by ${want.holder}` : ''}) minted for user ${s.userId}, role ${role}, scopes ${minted.view.scopes.join(' ')}, ${minted.view.endsAt === null ? 'no fixed end' : `until ${minted.view.endsAt}`}${box ? ', box' : ''}`);
    return minted;
  }

  const listed = (userId: string): { grants: ApiGrantView[]; tokens: ApiTokenView[] } => ({ grants: o.grants.list(userId), tokens: o.sessions.apiTokens(userId) });

  app.get('/api/api-tokens', async (req) => {
    const userId = userIdOf(req);
    if (userId === undefined) throw new HttpError(401, 'sign in to list API tokens');
    return { ...listed(userId), scopes: known, settings: o.grants.settings() };
  });

  app.get('/api/scopes', async (): Promise<ScopeRegistry> => o.registry);

  app.post('/ui/api/api-tokens', o.allow('viewer'), async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = o.sessionOf(req)!;
    if (s.kind === 'api' && (req.body as { action?: unknown } | undefined)?.action === 'mint') throw new HttpError(403, MINT_REFUSED);
    const edit = parseWith(apiTokenBody, req.body);
    if (edit.action === 'revoke') {
      if (!o.grants.revoke(s.userId, edit.id) && !o.sessions.revokeApiToken(s.userId, edit.id)) throw new HttpError(404, `no grant or API token ${edit.id}`);
      return listed(s.userId);
    }
    if (edit.action === 'revoke-all') {
      o.grants.revokeAll(s.userId);
      for (const t of o.sessions.apiTokens(s.userId)) o.sessions.revokeApiToken(s.userId, t.id);
      return listed(s.userId);
    }
    return grant(s, edit, o.caller(req));
  });

  app.post('/ui/api/api-tokens/settings', o.instance, async (req): Promise<ApiTokenSettings> => {
    const { tokenMinutes } = parseWith(apiTokenSettingsBody, req.body);
    const settings = o.grants.setTokenMinutes(tokenMinutes);
    const s = o.sessionOf(req)!;
    console.warn(`hopper: the API-token lifetime is now ${tokenMinutes} minutes`);
    o.tenants.user(s.userId)?.store.events.append({ type: 'api_tokens.settings_changed', data: { tokenMinutes } });
    return settings;
  });

  // The exchange and the refresh are sign-ins: each has the sign-in limit, per caller (issue #795), in its own context.
  app.register(async (exchange) => {
    await exchange.register(rateLimit, signInLimit(o.caller));
    exchange.post('/ui/auth/api-token', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const at = await apiDoor(req);
      if ('error' in at) {
        console.warn(`hopper: API token exchange refused: ${at.error}`);
        throw new HttpError(at.status, at.error);
      }
      return exchanged(at.userId, at.who, at.role, parseWith(apiTokenExchangeBody, req.body ?? {}));
    });
  });
  app.register(async (refresh) => {
    await refresh.register(rateLimit, signInLimit(o.caller));
    refresh.post('/ui/auth/token/refresh', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const r = o.grants.refresh(parseWith(tokenRefreshBody, req.body ?? {}).refresh, o.caller(req));
      if (!r.ok) {
        console.warn(`hopper: token refresh refused: ${r.error}`);
        throw new HttpError(401, r.error);
      }
      return r.value;
    });
  });
}
