// Local accounts' UI routes (issue #1380, design.md "Local accounts"): an instance admin adds, changes or removes one
// (POST /ui/api/local-accounts); a session of a local account changes its own password (POST
// /ui/api/local-accounts/password). The rules are src/http/local-accounts.ts's.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accountEmail, passwordSchema } from '../../auth/local-accounts.ts';
import { UI_ROLES, type LocalAccountsView } from '../../domain/types.ts';
import { parseWith } from '../errors.ts';
import type { LocalAccountsAdmin } from '../local-accounts.ts';
import type { Operation } from '../openapi-operation.ts';
import type { UiSession } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const localAccountsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), email: accountEmail, role: z.enum(UI_ROLES), password: passwordSchema.optional() }),
  z.strictObject({ action: z.literal('remove'), email: accountEmail }),
]);
export const ownPasswordBody = z.strictObject({ current: z.string().max(1024), password: passwordSchema });

export function registerLocalAccountRoutes(app: FastifyInstance, o: {
  instance: Guard; viewer: Guard; localAccounts: LocalAccountsAdmin; sessionOf: (req: FastifyRequest) => UiSession | undefined;
}): void {
  app.post('/ui/api/local-accounts', o.instance, async (req): Promise<LocalAccountsView> => {
    const s = o.sessionOf(req)!;
    return o.localAccounts.edit(parseWith(localAccountsEditBody, req.body), s.identity, s.userId);
  });
  app.post('/ui/api/local-accounts/password', o.viewer, async (req) => {
    const s = o.sessionOf(req)!;
    await o.localAccounts.changePassword(s.identity, { ...parseWith(ownPasswordBody, req.body), keep: s.token });
    return { ok: true };
  });
}

export const LOCAL_ACCOUNT_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/local-accounts', tag: 'Sign-in', summary: 'The local accounts', description: 'Only the instance admin (issue #1380). Each local account: its email, its role, when it was added, and the user it signs in as once it has signed in. Never a password or its hash. Loopback, or a UI session with role **admin**.', returns: '`LocalAccountsView`', errors: [403] },
  { method: 'post', path: '/ui/api/local-accounts', tag: 'Sign-in', summary: 'Add, change or remove a local account', description: 'Only the instance admin (issue #1380). `save` adds an account (email, role, password) or changes one\'s role and, given, its password: only the hash is kept, and a new password ends the account\'s sessions. `remove` removes one. Refused (409) when the account signs in as another user and the change would set its password or add it again — an admin never gets a way into another user\'s work —, or when it would remove or lower the account the acting session signed in with; (404) no such account.', role: 'admin', body: localAccountsEditBody, returns: 'the new view, as GET /api/local-accounts', errors: [403, 404, 409] },
  { method: 'post', path: '/ui/api/local-accounts/password', tag: 'Sign-in', summary: 'Change your own password', description: 'For a session signed in with a local account (issue #1380): the current password, then the new one (12 characters at least). The account\'s other sessions and API tokens end. 400 when the current password is wrong; 409 when the session did not sign in with a local account.', role: 'viewer', body: ownPasswordBody, returns: '`{ ok: true }`', errors: [400, 409] },
];
