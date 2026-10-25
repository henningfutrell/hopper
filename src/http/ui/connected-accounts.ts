// A user's connected accounts from the UI (issues #214, #1380, #1448, design.md "Connected accounts" and "More than one
// GitHub account"): connect GitHub through the hopper's app or with a personal access token, add a further account with a
// token of its own, choose each account's job repositories, cancel, disconnect. The user's own accounts: their session's
// user alone, an admin's act.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RepositoryTaken } from '../../connected-accounts/account-set.ts';
import { NEW_REPOSITORY_MODES } from '../../domain/new-repositories.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, isConnectedAccountKey, providerOfKey, type ConnectedAccountKey } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** A connected account's key (issue #1448): absent, the provider's first account. */
const accountKey = z.string().refine(isConnectedAccountKey, 'a connected account key: github, github-2, …').optional();
const REPOSITORY = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo'), MODE = z.enum(NEW_REPOSITORY_MODES);
const TOKEN = z.string().trim().min(1).max(1024).regex(/^\S+$/, 'one token, no spaces');
export const connectedAccountsBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['connect', 'cancel', 'disconnect', 'take-held', 'drop-held']), provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), key: accountKey }),
  // Issue #321: the job repositories, the whole list.
  z.strictObject({ action: z.literal('choose'), provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), key: accountKey, repositories: z.array(REPOSITORY).max(5000) }),
  // Issue #2795: the new-repository policy, the whole of it, and asks to dismiss.
  z.strictObject({
    action: z.literal('new-repositories'), provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), key: accountKey,
    policy: z.strictObject({ mode: MODE, owners: z.record(z.string().regex(/^[^/\s]+$/, 'an owner: a GitHub account or organization'), MODE) }).optional(), dismiss: z.array(REPOSITORY).max(5000).optional(),
  }),
  // Issue #1380: a personal access token, with no GitHub App; never logged, never answered.
  z.strictObject({ action: z.literal('connect-token'), provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), key: accountKey, token: TOKEN }),
  // Issue #1448: a further account, with a personal access token of its own.
  z.strictObject({ action: z.literal('add-token'), provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), token: TOKEN }),
]).refine((b) => !('key' in b) || b.key === undefined || providerOfKey(b.key as ConnectedAccountKey) === b.provider, { message: 'the key is an account at another provider', path: ['key'] });

/** Its part of the API reference (src/http/openapi.ts). */
export const CONNECTED_ACCOUNTS_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/connected-accounts', tag: 'Jobs', summary: 'Connect GitHub, add another GitHub account, cancel, disconnect, choose job repositories, or set what happens to new repositories', description: '`connect` runs the provider\'s device flow through the hopper\'s app (its public client id, no secret) and answers once it shows the device code; a waiting one answers its own code. Once approved, the account\'s issues in its job repositories become jobs, and the jobs act through it. Signing in with GitHub connects it too. `connect-token` connects with a personal access token (`token`) instead, with no GitHub App (issue #1380): GitHub must take it and the source email match applies; it is kept in the user\'s vault as the connection\'s token, never renewed and never deleted at GitHub, and its repositories are the ones the token reaches; a refusal answers `failed` with why, and a connection there was stays. `choose` sets the job repositories, the whole list (none: no job); the source syncs at once. `disconnect` revokes the account\'s grant at GitHub (best effort), forgets the account and its token, and keeps the job repositories. A connect over a live connection revokes the grant it replaces. `key` names a further account (issue #1448; absent: the provider\'s first; one not connected: 404). `add-token` adds a further account with a personal access token of its own: GitHub must take it, the source email match applies, and its login must not be connected already; it answers the new account under its key, or `failed` with why and nothing kept; with no first account it connects the first. Each account has its own job repositories, and a repository is a job repository of one account only (`choose` of one chosen for another account: 409). `disconnect` of a further account forgets it, its token and its job repositories. `new-repositories` (issue #2795) sets the account\'s new-repository policy (`policy`, the whole of it: `mode` for every owner, `owners` an owner\'s own mode, each `ask` or `accept`) or dismisses its new-repository asks (`dismiss`). A repository the account reaches that no read before saw is new: `accept` adds it to the job repositories at once, `ask` (the default) holds it as an ask in `newRepositories.asks` until a person adds it with `choose` or dismisses it. A new policy applies at once to what the last read reached.', role: 'admin', body: connectedAccountsBody, returns: '`ConnectedAccountStatus`', errors: [400, 404, 409] },
];

export function registerConnectedAccountsRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; email: (req: FastifyRequest) => string | undefined }): void {
  app.post('/ui/api/connected-accounts', o.admin, async (req) => {
    const body = parseWith(connectedAccountsBody, req.body);
    const { connectedAccounts } = o.tenant(req);
    // The source email match (issue #1380): the account must have the email the session's identity signed in with.
    const email = o.email(req), by = email ? { email } : {};
    if (body.action === 'add-token') return connectedAccounts.add(body.provider, body.token, by); // a further account (issue #1448)
    const key = (body.key ?? body.provider) as ConnectedAccountKey;
    if (!connectedAccounts.keys().includes(key)) throw new HttpError(404, `no connected account ${key}: Sources → Add another ${body.provider === 'github' ? 'GitHub' : body.provider} account`);
    if (body.action === 'new-repositories') return connectedAccounts.newRepositories(key, { ...(body.policy ? { policy: body.policy } : {}), ...(body.dismiss ? { dismiss: body.dismiss } : {}) });
    if (body.action === 'choose') return connectedAccounts.choose(key, body.repositories).catch((e: Error) => { throw e instanceof RepositoryTaken ? new HttpError(409, e.message) : e; });
    if (body.action === 'connect') return connectedAccounts.connect(key, by); if (body.action === 'connect-token') return connectedAccounts.connectToken(key, body.token, by); // a personal access token (issue #1380)
    if (body.action === 'take-held') return connectedAccounts.takeHeld(key).catch((e: Error) => { throw new HttpError(409, e.message); });
    return body.action === 'cancel' ? connectedAccounts.cancel(key) : body.action === 'drop-held' ? connectedAccounts.dropHeld(key) : connectedAccounts.disconnect(key);
  });
}
