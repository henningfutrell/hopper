// API tokens (issue #718, design.md "API tokens"): everything a person does in the UI, an agent does over the API with a
// short-lived token scoped to what its user may do. A person mints one from their UI session (Settings, or the operator
// CLI's session); an agent with no UI session exchanges a sign-in the API door accepts — a gateway realm's JWT, a GitHub
// token of the user's connected account — for one, as the user it is linked to. A token lives an hour at most, acts with
// a role no higher than its minter's, never mints another, and Access decides each use. The token is answered once, in
// the answer that made it, and only its hash is kept (a session row of kind `api`).
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS_UNAVAILABLE, API_TOKEN_DEFAULT_MINUTES, API_TOKEN_MAX_MINUTES, UI_ROLES, roleAllows, type ApiTokenMinted, type ApiTokenView, type Identity, type UiRole } from '../../domain/types.ts';
import type { Access } from '../../authz/service.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { createApiDoor, userIdOf, type Tenants } from '../tenants.ts';
import type { SignIn } from '../../auth/index.ts';
import { apiTokenIdOf, type UiSession, type UiSessions } from './sessions.ts';
import { SIGN_IN_RATE, signInLimit, type CallerOf } from './sign-in.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const wanted = {
  label: z.string().trim().min(1).max(64),
  role: z.enum(UI_ROLES).optional(),
  minutes: z.number().int().min(1).max(API_TOKEN_MAX_MINUTES).optional(),
};
export const apiTokenBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('mint'), ...wanted }),
  z.strictObject({ action: z.literal('revoke'), id: z.string().regex(/^[0-9a-f]{16}$/, 'an API token id: 16 hex digits') }),
]);
export const apiTokenExchangeBody = z.strictObject(wanted);

const LIFETIME = `at most ${API_TOKEN_MAX_MINUTES} minutes (\`minutes\`, default ${API_TOKEN_DEFAULT_MINUTES})`;
const USE = 'Send it as `Authorization: Bearer <token>` on any `GET /api/*` or `POST /ui/api/*` route: it acts as a UI session of its user with its role would, with no Origin needed, and Access (`api_token#can_view`, `can_operate` or `can_administer`, for the role the route needs) decides each use.';

export const API_TOKEN_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/api-tokens', tag: 'API tokens', summary: 'List API tokens', description: 'The request\'s user\'s live API tokens (issue #718): id, label, role, when each started, ends and was last used. Never a token.', returns: '`{ tokens: ApiTokenView[] }`' },
  { method: 'post', path: '/ui/api/api-tokens', tag: 'API tokens', summary: 'Mint or revoke an API token', description: `\`mint\`: a new API token for the session's user, with a \`label\` (who or what uses it), a \`role\` no higher than the session's (default: the session's), living ${LIFETIME}. The token is answered once and never again; not cached. ${USE} An API token may not mint one (403). \`revoke\`: end one of the user's tokens by its id (404 when there is none); answers the tokens left. 503 when OpenFGA cannot be asked.`, role: 'viewer', body: apiTokenBody, returns: 'mint: `ApiTokenMinted`; revoke: `{ tokens: ApiTokenView[] }`', errors: [400, 403, 404, 503] },
  { method: 'post', path: '/ui/auth/api-token', tag: 'API tokens', summary: 'Exchange a sign-in for an API token', description: `For an agent with no UI session (issue #718): \`Authorization: Bearer <a gateway realm's JWT, or a GitHub token>\`, checked as the API door checks it, mints an API token for the user the sign-in is linked to (a GitHub account: the user whose connected account it is), with a \`label\`, a \`role\` no higher than the one the sign-in config grants (default: that one), living ${LIFETIME}. ${USE} 401 when the sign-in is refused or names no hopper user (the door signs nobody new in), or is itself an API token; 403 when no role is granted or Access refuses; 503 when OpenFGA cannot be asked; 429 past ${SIGN_IN_RATE} exchanges a minute from one caller (behind the tunnel: the caller its edge names). Not cached.`, body: apiTokenExchangeBody, returns: '`ApiTokenMinted`', errors: [400, 401, 403, 429, 502, 503] },
];

export function registerApiTokenRoutes(app: FastifyInstance, o: {
  allow: (needs: UiRole) => Guard; sessions: UiSessions; sessionOf: (req: FastifyRequest) => UiSession | undefined;
  access: Pick<Access, 'decideApiToken'>; tenants: Tenants; signIn: Pick<SignIn, 'checkToken'>; caller: CallerOf;
}): void {
  const apiDoor = createApiDoor(o);

  /** A new token for `userId`, as `identity`, its role at most `most`; Access must allow that role, or it is dropped again. */
  async function mint(userId: string, identity: Identity, most: UiRole, want: z.output<typeof apiTokenExchangeBody>): Promise<ApiTokenMinted> {
    const role = want.role ?? most;
    if (!roleAllows(most, role)) throw new HttpError(403, `an API token may not act above its minter: ${role} is above ${most}`);
    const minutes = want.minutes ?? API_TOKEN_DEFAULT_MINUTES;
    const s = o.sessions.create({ role, identity, userId, lastsMs: minutes * 60_000, api: { label: want.label } });
    const id = apiTokenIdOf(s.token);
    const d = await o.access.decideApiToken({ userId, tokenId: id, role });
    if (!d.allowed) {
      o.sessions.revokeApiToken(userId, id);
      if (d.unavailable) throw new HttpError(503, `${ACCESS_UNAVAILABLE}: ${d.reason}`);
      throw new HttpError(403, `no API token is minted: ${d.reason}`);
    }
    console.warn(`hopper: API token ${id} (${want.label}) minted for user ${userId}, role ${role}, ${minutes} minutes`);
    const view = o.sessions.apiTokens(userId).find((t) => t.id === id)!;
    return { ...view, token: s.token };
  }

  const listed = (userId: string): { tokens: ApiTokenView[] } => ({ tokens: o.sessions.apiTokens(userId) });

  app.get('/api/api-tokens', async (req) => {
    const userId = userIdOf(req);
    if (userId === undefined) throw new HttpError(401, 'sign in to list API tokens');
    return listed(userId);
  });

  app.post('/ui/api/api-tokens', o.allow('viewer'), async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = o.sessionOf(req)!;
    const edit = parseWith(apiTokenBody, req.body);
    if (edit.action === 'revoke') {
      if (!o.sessions.revokeApiToken(s.userId, edit.id)) throw new HttpError(404, `no API token ${edit.id}`);
      return listed(s.userId);
    }
    if (s.kind === 'api') throw new HttpError(403, 'an API token may not mint an API token: a person mints one, or an agent exchanges its sign-in at POST /ui/auth/api-token');
    const { action: _, ...want } = edit;
    return mint(s.userId, s.identity, s.role, want);
  });

  // The exchange is a sign-in: it has the sign-in limit, per caller (issue #795), in its own context.
  app.register(async (exchange) => {
    await exchange.register(rateLimit, signInLimit(o.caller));
    exchange.post('/ui/auth/api-token', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const at = await apiDoor(req);
      if ('error' in at) {
        console.warn(`hopper: API token exchange refused: ${at.error}`);
        throw new HttpError(at.status, at.error);
      }
      return mint(at.userId, at.who, at.role, parseWith(apiTokenExchangeBody, req.body ?? {}));
    });
  });
}
