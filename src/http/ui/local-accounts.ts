// Local accounts' UI routes (issue #1380, design.md "Local accounts"): an instance admin adds, changes or removes one
// (POST /ui/api/local-accounts); a session of a local account changes its own password (POST
// /ui/api/local-accounts/password), and adds, reads and removes its own passkeys (issue #1380, design.md "Passkeys for
// local accounts"; the WebAuthn checks are src/auth/passkeys.ts's). The rules are src/http/local-accounts.ts's.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { accountEmail, LOCAL_ACCOUNTS_REALM, passwordSchema } from '../../auth/local-accounts.ts';
import { PasskeyRefused, relyingParty, type Passkeys } from '../../auth/passkeys.ts';
import { UI_ROLES, type LocalAccountsView, type PasskeysView } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { LocalAccountsAdmin } from '../local-accounts.ts';
import type { Operation } from '../openapi-operation.ts';
import type { UiSession } from './sessions.ts';
import { passkeySignInBody } from './sign-in.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const localAccountsEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('save'), email: accountEmail, role: z.enum(UI_ROLES), password: passwordSchema.optional() }),
  z.strictObject({ action: z.literal('remove'), email: accountEmail }),
]);
export const ownPasswordBody = z.strictObject({ current: z.string().max(1024), password: passwordSchema });
export const passkeyAddBody = z.strictObject({ name: z.string().trim().min(1).max(64), response: z.record(z.string(), z.unknown()) });
export const passkeyRemoveBody = z.strictObject({ id: z.string().min(1).max(1024) });

export function registerLocalAccountRoutes(app: FastifyInstance, o: {
  instance: Guard; viewer: Guard; localAccounts: LocalAccountsAdmin; sessionOf: (req: FastifyRequest) => UiSession | undefined;
  passkeys: Passkeys; isUiOrigin: (origin: string) => boolean;
}): void {
  /** The local account the request's session signed in with: its passkeys are its own. */
  const own = (req: FastifyRequest): string => {
    const s = o.sessionOf(req);
    if (!s) throw new HttpError(401, 'sign in to read your passkeys');
    if (s.identity.realm !== LOCAL_ACCOUNTS_REALM) throw new HttpError(409, `you signed in with ${s.identity.realm}, not a local account: passkeys are for local accounts`);
    return s.identity.subject;
  };
  /** The relying party: the UI origin the browser is on. */
  const rpOf = (req: FastifyRequest) => {
    const origin = req.headers.origin?.toLowerCase();
    if (origin === undefined || !o.isUiOrigin(origin)) throw new HttpError(403, `origin ${origin ?? '(none)'} not allowed`);
    return relyingParty(origin);
  };
  const refused = (e: unknown): never => { throw e instanceof PasskeyRefused ? new HttpError(400, e.message) : e; };

  app.get('/api/local-accounts/passkeys', async (req): Promise<PasskeysView> => ({ passkeys: o.passkeys.view(own(req)) }));
  app.post('/ui/api/local-accounts/passkeys/options', o.viewer, async (req) => {
    const email = own(req);
    return o.passkeys.registrationOptions(email, o.sessionOf(req)!.token, rpOf(req));
  });
  app.post('/ui/api/local-accounts/passkeys', o.viewer, async (req): Promise<PasskeysView> => {
    const email = own(req);
    const { name, response } = parseWith(passkeyAddBody, req.body);
    const passkeys = await o.passkeys.register(email, o.sessionOf(req)!.token, rpOf(req), response, name).catch(refused);
    console.warn(`hopper: passkey "${name}" added by its own local account ${email}`);
    return { passkeys };
  });
  app.post('/ui/api/local-accounts/passkeys/remove', o.viewer, async (req): Promise<PasskeysView> => {
    const email = own(req);
    const { id } = parseWith(passkeyRemoveBody, req.body);
    if (!o.passkeys.remove(email, id)) throw new HttpError(404, 'you have no passkey of that id');
    console.warn(`hopper: a passkey removed by its own local account ${email}`);
    return { passkeys: o.passkeys.view(email) };
  });

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
  { method: 'post', path: '/ui/auth/passkey/options', tag: 'Sign-in', summary: 'Begin sign-in with a passkey', description: 'While a local account has a passkey (issue #1380): the WebAuthn request options for `navigator.credentials.get()`, for the host name of the UI origin, and the `flow` the answer comes back with. The challenge waits 5 minutes and is used once. No email asked: the passkey names its account.', returns: '`{ flow, options }`' },
  { method: 'post', path: '/ui/auth/passkey', tag: 'Sign-in', summary: 'Sign in with a passkey', description: 'The `flow` and the browser\'s answer to its options (issue #1380). The hopper checks the answer (@simplewebauthn/server): this origin and host name, user verification, the passkey\'s signature. Its local account signs in, with the account\'s role. 403 for an unknown, removed or wrong passkey, or a used or expired flow.', body: passkeySignInBody, returns: '`{ token, expiresAt, user }`' },
  { method: 'get', path: '/api/local-accounts', tag: 'Sign-in', summary: 'The local accounts', description: 'Only the instance admin (issue #1380). Each local account: its email, its role, when it was added, and the user it signs in as once it has signed in. Never a password or its hash. Loopback, or a UI session with role **admin**.', returns: '`LocalAccountsView`', errors: [403] },
  { method: 'post', path: '/ui/api/local-accounts', tag: 'Sign-in', summary: 'Add, change or remove a local account', description: 'Only the instance admin (issue #1380). `save` adds an account (email, role, password) or changes one\'s role and, given, its password: only the hash is kept, and a new password ends the account\'s sessions. `remove` removes one. Refused (409) when the account signs in as another user and the change would set its password or add it again — an admin never gets a way into another user\'s work —, or when it would remove or lower the account the acting session signed in with; (404) no such account.', role: 'admin', body: localAccountsEditBody, returns: 'the new view, as GET /api/local-accounts', errors: [403, 404, 409] },
  { method: 'get', path: '/api/local-accounts/passkeys', tag: 'Sign-in', summary: 'Your passkeys', description: 'For a session signed in with a local account (issue #1380): its passkeys, each with its name, the host name it signs in at, and when it was added and last used. Never a key. 409 when the session did not sign in with a local account.', returns: '`PasskeysView`', errors: [401, 409] },
  { method: 'post', path: '/ui/api/local-accounts/passkeys/options', tag: 'Sign-in', summary: 'Begin adding a passkey', description: 'For a session signed in with a local account (issue #1380): the WebAuthn creation options for `navigator.credentials.create()`, for the host name of the UI origin. A discoverable credential with user verification. The challenge is this session\'s, for 5 minutes, used once.', role: 'viewer', returns: 'the creation options (JSON)', errors: [403, 409] },
  { method: 'post', path: '/ui/api/local-accounts/passkeys', tag: 'Sign-in', summary: 'Add a passkey', description: 'For a session signed in with a local account (issue #1380): `name`, and the browser\'s answer to the creation options. The hopper checks it (@simplewebauthn/server) and keeps only the public key. The passkey then signs the account in at this host name, in place of its password. 400 when the answer does not verify, its challenge is not this session\'s, or the passkey is already added.', role: 'viewer', body: passkeyAddBody, returns: '`PasskeysView`', errors: [400, 403, 409] },
  { method: 'post', path: '/ui/api/local-accounts/passkeys/remove', tag: 'Sign-in', summary: 'Remove a passkey', description: 'For a session signed in with a local account (issue #1380): one of its own passkeys, by id. It signs nobody in any more. 404 when the account has no passkey of that id.', role: 'viewer', body: passkeyRemoveBody, returns: '`PasskeysView`', errors: [404, 409] },
  { method: 'post', path: '/ui/api/local-accounts/password', tag: 'Sign-in', summary: 'Change your own password', description: 'For a session signed in with a local account (issue #1380): the current password, then the new one (12 characters at least). The account\'s other sessions and API tokens end. 400 when the current password is wrong; 409 when the session did not sign in with a local account.', role: 'viewer', body: ownPasswordBody, returns: '`{ ok: true }`', errors: [400, 409] },
];
