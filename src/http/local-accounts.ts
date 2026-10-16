// Local accounts managed from Settings → Sign-in (issue #1380, design.md "Local accounts"): GET /api/local-accounts reads
// them — never a hash — (an instance read), `localAccounts.edit` behind POST /ui/api/local-accounts adds, changes or
// removes one, and `localAccounts.changePassword` behind POST /ui/api/local-accounts/password is an account's own change
// of its password. A password is hashed here (scrypt) and only the hash is stored.
//
// An admin runs the instance, never another user's work (issue #221, design.md "What an admin sees"): no change here sets
// the password of, or adds again, an account that signs in as another user — that would hand the admin a way into that
// user's work. Since identity is keyed by email (issue #1380), that is also a new account of another user's email. The account's own user changes its password, which ends the account's other sessions. Nobody locks
// themselves out: the acting account is not removed, nor its role lowered from admin, from here.
import type { FastifyInstance } from 'fastify';
import type { SignIn } from '../auth/index.ts';
import { hashPassword, LOCAL_ACCOUNTS_REALM, verifyPassword } from '../auth/local-accounts.ts';
import type { Clock, InstanceStore } from '../domain/ports.ts';
import { roleAllows, type Identity, type LocalAccountsEdit, type LocalAccountsView } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';
import type { ApiGrants } from './ui/api-grants.ts';
import type { UiSessions } from './ui/sessions.ts';

export interface LocalAccountsAdmin {
  view(): LocalAccountsView;
  /** Make `edit` as `actor`, signed in as user `actorUser`; throws HttpError (404 no such account, 409 another user's account or a lockout). */
  edit(edit: LocalAccountsEdit, actor: Identity, actorUser: string): Promise<LocalAccountsView>;
  /** The local account `actor` signed in with takes `password`, `current` checked first; its other sessions end (`keep` stays). */
  changePassword(actor: Identity, o: { current: string; password: string; keep: string }): Promise<void>;
}

const NOT_YOURS = 'signs in as another user: only that user sets its password (an admin runs the hopper, never another user\'s work)';

export function createLocalAccountsAdmin(o: {
  instance: Pick<InstanceStore, 'localAccounts' | 'localAccountPasskeys' | 'identities' | 'users'>;
  signIn: Pick<SignIn, 'roleOf'>; sessions: UiSessions; grants: Pick<ApiGrants, 'reconcile'>; clock: Clock;
}): LocalAccountsAdmin {
  const accounts = o.instance.localAccounts;
  // The user the account signs in as: the one its identity is linked to, else the user known by its email (issue #1380).
  const userOf = (email: string): string | undefined => o.instance.identities.userOf(LOCAL_ACCOUNTS_REALM, email) ?? o.instance.users.byEmail(email)?.id;
  const view = (): LocalAccountsView => ({
    accounts: accounts.list().map((a) => {
      const id = userOf(a.email);
      const user = id === undefined ? undefined : o.instance.users.get(id)?.name ?? id;
      return { email: a.email, role: a.role, createdAt: a.createdAt, ...(user ? { user } : {}), passkeys: o.instance.localAccountPasskeys.list(a.email).length };
    }),
  });
  const own = (actor: Identity, email: string): boolean => actor.realm === LOCAL_ACCOUNTS_REALM && actor.subject === email;
  return {
    view,
    async edit(edit, actor, actorUser) {
      const email = edit.email.toLowerCase();
      const existing = accounts.get(email);
      const linked = userOf(email);
      if (edit.action === 'remove') {
        if (!existing) throw new HttpError(404, `no local account ${email}`);
        if (own(actor, email)) throw new HttpError(409, 'this is the account you signed in with: sign in as an admin another way first');
        accounts.remove(email);
      } else {
        // A new account takes the user its email signed in as before, or the user known by its email; a password set on it
        // would be a way into that user's work.
        if (linked !== undefined && linked !== actorUser && (!existing || edit.password !== undefined)) throw new HttpError(409, `${email} ${NOT_YOURS}`);
        if (!existing && edit.password === undefined) throw new HttpError(400, 'a new local account needs a password');
        if (own(actor, email) && !roleAllows(edit.role, 'admin')) throw new HttpError(409, 'this would end your own admin session: sign in as an admin another way first');
        const passwordHash = edit.password === undefined ? existing!.passwordHash : await hashPassword(edit.password);
        accounts.put({ email, passwordHash, role: edit.role, createdAt: existing?.createdAt ?? o.clock.now().toISOString() });
        if (existing && edit.password !== undefined) o.sessions.endIdentity({ realm: LOCAL_ACCOUNTS_REALM, subject: email });
      }
      const r = o.sessions.reconcile(o.signIn.roleOf);
      const g = o.grants.reconcile(o.signIn.roleOf);
      console.warn(`hopper: local account ${edit.action === 'remove' ? 'removed' : existing ? 'changed' : 'added'} in the UI by ${actor.realm} ${actor.subject} (${email}${edit.action === 'save' ? `, role ${edit.role}${edit.password === undefined ? '' : ', password set'}` : ''}); ${r.dropped} session(s) ended, ${r.changed} changed role; ${g.dropped} grant(s) ended, ${g.changed} lowered`);
      return view();
    },
    async changePassword(actor, { current, password, keep }) {
      const account = actor.realm === LOCAL_ACCOUNTS_REALM ? accounts.get(actor.subject) : undefined;
      if (!account) throw new HttpError(409, `you signed in with ${actor.realm}, not a local account: your password is kept there`);
      if (!await verifyPassword(account.passwordHash, current)) throw new HttpError(400, 'the current password is wrong');
      accounts.put({ ...account, passwordHash: await hashPassword(password) });
      const ended = o.sessions.endIdentity(actor, keep);
      console.warn(`hopper: password changed by its own local account ${actor.subject}; ${ended} other session(s) ended`);
    },
  };
}

export function localAccountRoutes(app: FastifyInstance, o: { localAccounts: LocalAccountsAdmin; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/local-accounts', async (req): Promise<LocalAccountsView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the local accounts');
    return o.localAccounts.view();
  });
}
