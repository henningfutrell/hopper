// Sign-in managed from Settings → Sign-in (issues #185, #198, #200, design.md "Sign-in: realms"): GET /api/realms
// reads the realms, with each one's settings and a password realm's accounts (an instance read: an
// admin session, or loopback without one), and `realmsAdmin.edit` behind POST /ui/api/realms (src/http/ui/)
// makes one change. A password is hashed here (argon2) and only the hash is stored. A change is loaded
// with its secrets before it is stored — settings that would not load are refused, naming the field —
// then written against the version read, applied to sign-in at once, and applied to the stored sessions
// as a start would. A change that would leave the acting session without admin is refused: nobody
// locks themselves out from the UI.
import type { FastifyInstance } from 'fastify';
import { accountOf, AuthEditError, editSignIn, hashPassword, loadSignInConfig, realmsView, roleIn, type SignIn, type SignInEdit } from '../auth/index.ts';
import type { InstanceStore } from '../domain/store.ts';
import { roleAllows, type Identity, type RealmsEdit, type RealmsView } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import type { UiSessions } from './ui/sessions.ts';

export interface RealmsAdmin {
  view(): RealmsView;
  /** Make `edit` as `actor`; throws HttpError (400 invalid, 404 no such realm or account, 409 moved or a lockout). */
  edit(edit: RealmsEdit, actor: Identity): Promise<RealmsView>;
}

const MOVED = 'the sign-in config changed since they were read: reload and make the change again';

export function createRealmsAdmin(o: {
  instance: Pick<InstanceStore, 'signInConfig' | 'identities' | 'users' | 'tx'>; secret: (name: string) => string | undefined; signIn: SignIn; sessions: UiSessions;
}): RealmsAdmin {
  const store = o.instance.signInConfig;
  /** The user an account signs in as, when it is linked to one. */
  const userOf = (realm: string, username: string) => {
    const id = o.instance.identities.userOf(realm, username);
    const user = id === undefined ? undefined : o.instance.users.get(id);
    return user ? { user: { id: user.id, name: user.name } } : {};
  };
  const view = (): RealmsView => {
    const origin = o.signIn.origin();
    const v = realmsView(store.read());
    return {
      version: store.version(), local: v.local, none: v.none, origin,
      realms: v.realms.map((r) => {
        if (r.type === 'password') return { ...r, accounts: (r.accounts ?? []).map((a) => ({ ...a, ...userOf(r.name, a.username) })) };
        if (r.type === 'ldap') return r;
        const urls = { callback: `${origin}/ui/auth/${r.name}/callback` };
        return r.type === 'saml' ? { ...r, ...urls, metadata: `${origin}/ui/auth/${r.name}/metadata` } : { ...r, ...urls };
      }),
    };
  };

  /** The account change with its password hashed; refuses a user that does not exist or an account moved to another. */
  const accountChange = async (before: ReturnType<typeof store.read>, edit: Extract<RealmsEdit, { action: 'account' }>): Promise<SignInEdit> => {
    const { password, user, version: _version, ...rest } = edit;
    if (user !== undefined) {
      if (!o.instance.users.get(user)) throw new HttpError(400, `no user ${user}: Settings → Users lists them`);
      const existing = accountOf(before, edit.realm, edit.username);
      const linked = existing && o.instance.identities.userOf(edit.realm, existing.username);
      if (linked !== undefined && linked !== user) throw new HttpError(400, `${existing!.username} signs in as user ${linked}: an account keeps its user; remove it and add it again to change that`);
    }
    return password === undefined ? rest : { ...rest, passwordHash: await hashPassword(password) };
  };

  return {
    view,
    async edit(edit, actor) {
      const before = store.read();
      const { version } = edit;
      if (version !== store.version()) throw new HttpError(409, MOVED);
      let change: SignInEdit;
      if (edit.action === 'account') change = await accountChange(before, edit);
      else {
        const { version: _version, ...rest } = edit;
        change = rest;
      }
      let next;
      try {
        next = editSignIn(before, change);
      } catch (e) {
        if (e instanceof AuthEditError) throw new HttpError(e.status, e.message);
        throw e;
      }
      let config;
      try {
        config = loadSignInConfig(next, o.secret);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const role = roleIn(config, actor);
      if (role === null || !roleAllows(role, 'admin')) {
        throw new HttpError(409, `this change would end your own admin session (${actor.realm}): sign in as an admin another way first, or change it with hopper config set sign-in`);
      }
      o.instance.tx(() => {
        if (!store.write(next, version)) throw new HttpError(409, MOVED);
        if (edit.action === 'account' && edit.user !== undefined) o.instance.identities.replace(edit.realm, accountOf(next, edit.realm, edit.username)!.username, edit.user);
      });
      o.signIn.apply(config);
      const r = o.sessions.reconcile(o.signIn.roleOf);
      const what = edit.action === 'save' ? `${edit.name === undefined ? 'add' : 'save'} ${edit.realm.name}`
        : edit.action === 'account' || edit.action === 'account-remove' ? `${edit.action} ${edit.realm}/${edit.username}`
          : 'name' in edit ? `${edit.action} ${edit.name}` : edit.action;
      console.warn(`hopper: sign-in changed in the UI by ${actor.realm} ${actor.subject} (${what}): applied; ${r.dropped} session(s) ended, ${r.changed} changed role`);
      return view();
    },
  };
}

export function realmRoutes(app: FastifyInstance, o: { realms: RealmsAdmin; sessions: UiSessions }): void {
  app.get('/api/realms', async (req): Promise<RealmsView> => {
    const s = o.sessions.find(sessionToken(req));
    if (s && !roleAllows(s.role, 'admin')) throw new HttpError(403, `role ${s.role} may not read the realms; it needs admin`);
    return o.realms.view();
  });
}
