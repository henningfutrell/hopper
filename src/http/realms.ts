// Sign-in managed from Settings → Sign-in (issues #185, #198, design.md "Sign-in: realms"): GET /api/realms
// reads the realms, with each one's settings — never a secret (an instance read: an admin session, or
// loopback without one), and `realmsAdmin.edit` behind POST /ui/api/realms (src/http/ui/) makes one
// change. A realm's secrets are stored as typed (issue #216). A change is loaded before it is stored —
// settings that would not load are refused, naming the field — then written against the version read,
// applied to sign-in at once, and applied to the stored sessions as a start would. A change that would
// leave the acting session without admin is refused: nobody locks themselves out from the UI.
//
// Two admin tiers (issue #242, docs/sign-in.md "Super admins"): any admin makes someone who has signed in
// admin (their subject joins their realm's admin rule); only a super admin makes them super admin or hands
// their own over. A change by a regular admin that would change who is a super admin (turning off or
// removing a super admin's realm) is refused.
//
// An admin runs the instance, never another user's work (issue #221, design.md "What an admin sees"): no
// sign-in is kept off while the hopper has more than one user (it signs everyone in as admin).
import type { FastifyInstance } from 'fastify';
import { AuthEditError, editSignIn, isSuperAdmin, loadSignInConfig, realmsView, roleIn, type AuthConfig, type SignIn } from '../auth/index.ts';
import type { InstanceStore } from '../domain/store.ts';
import { roleAllows, type Identity, type PersonView, type RealmsEdit, type RealmsView } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import { INSTANCE_ADMIN_ONLY, type InstanceAdmin } from './instance-admin.ts';
import type { UiSessions } from './ui/sessions.ts';

export interface RealmsAdmin {
  view(): RealmsView;
  /** Make `edit` as `actor`; throws HttpError (400 invalid, 404 no such realm, 409 moved or a lockout). */
  edit(edit: RealmsEdit, actor: Identity): RealmsView;
}

const MOVED = 'the sign-in config changed since they were read: reload and make the change again';

/** The super admins `config` makes now, as `realm subject` keys: those whose realm is there and on. */
const supersOf = (config: AuthConfig): string[] =>
  config.superAdmins.filter((a) => isSuperAdmin(config, a)).map((a) => `${a.realm} ${a.subject}`).sort();

export function createRealmsAdmin(o: {
  instance: Pick<InstanceStore, 'signInConfig' | 'users' | 'identities'>;
  /** The realms the environment set up at start. */
  environment: string[];
  signIn: SignIn; sessions: UiSessions;
}): RealmsAdmin {
  const store = o.instance.signInConfig;
  /** Everyone who has signed in through a realm: by their live session's identity when there is one, else by subject. */
  const people = (): PersonView[] => {
    const config = o.signIn.config();
    const live = new Map(o.sessions.identities().map((who) => [`${who.realm} ${who.subject}`, who]));
    return o.instance.identities.all()
      .filter((p) => config.realms.some((r) => r.name === p.realm))
      .map((p) => {
        const who: Identity = live.get(`${p.realm} ${p.subject}`) ?? { realm: p.realm, subject: p.subject, groups: [] };
        return { realm: p.realm, subject: p.subject, user: o.instance.users.get(p.userId)?.name ?? p.userId, role: roleIn(config, who), superAdmin: isSuperAdmin(config, who) };
      });
  };
  const view = (): RealmsView => {
    const origin = o.signIn.origin();
    const stored = store.read();
    const v = realmsView(stored);
    const first = stored.githubAdmin;
    const firstUser = first && o.instance.identities.userOf(first.realm, first.subject);
    const name = firstUser ? o.instance.users.get(firstUser)?.name : undefined;
    return {
      version: store.version(), local: v.local, none: v.none, origin,
      githubAdmin: first ? { realm: first.realm, ...(name ? { user: name } : {}) } : null,
      realms: v.realms.map((row) => {
        const r = o.environment.includes(row.name) ? { ...row, environment: true } : row;
        // A form, gateway or device realm (GitHub: issue #214) has no callback to register.
        if (r.type === 'ldap' || r.type === 'gateway' || r.type === 'github') return r;
        const urls = { callback: `${origin}/ui/auth/${r.name}/callback` };
        return r.type === 'saml' ? { ...r, ...urls, metadata: `${origin}/ui/auth/${r.name}/metadata` } : { ...r, ...urls };
      }),
      people: people(),
    };
  };

  return {
    view,
    edit(edit, actor) {
      const before = store.read();
      const { version } = edit;
      if (version !== store.version()) throw new HttpError(409, MOVED);
      if (edit.action === 'settings' && edit.none !== undefined && edit.none !== null && o.instance.users.list().length > 1) {
        throw new HttpError(409, 'no sign-in signs everyone in as admin: it stays off while the hopper has more than one user');
      }
      const current = o.signIn.config();
      const superActor = isSuperAdmin(current, actor);
      if (edit.action === 'super-admin' && !superActor) {
        throw new HttpError(403, 'only a super admin makes someone super admin or hands it over');
      }
      if ((edit.action === 'admin' || edit.action === 'super-admin') && o.instance.identities.userOf(edit.who.realm, edit.who.subject) === undefined) {
        throw new HttpError(404, `nobody has signed in as ${edit.who.subject} with ${edit.who.realm}`);
      }
      const { version: _version, ...rest } = edit;
      const change = rest.action === 'super-admin' ? { ...rest, from: { realm: actor.realm, subject: actor.subject } } : rest;
      let next;
      try {
        next = editSignIn(before, change);
      } catch (e) {
        if (e instanceof AuthEditError) throw new HttpError(e.status, e.message);
        throw e;
      }
      let config;
      try {
        config = loadSignInConfig(next);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      if (!superActor && supersOf(config).join('\n') !== supersOf(current).join('\n')) {
        throw new HttpError(403, 'this change would change who is a super admin: only a super admin may');
      }
      const role = roleIn(config, actor);
      if (role === null || !roleAllows(role, 'admin')) {
        throw new HttpError(409, `this change would end your own admin session (${actor.realm}): sign in as an admin another way first, or change it with hopper config set sign-in`);
      }
      if (!store.write(next, version)) throw new HttpError(409, MOVED);
      o.signIn.apply(config);
      const r = o.sessions.reconcile(o.signIn.roleOf);
      const what = edit.action === 'save' ? `${edit.name === undefined ? 'add' : 'save'} ${edit.realm.name}`
        : 'name' in edit ? `${edit.action} ${edit.name}`
          : 'who' in edit ? `${edit.action === 'super-admin' && edit.transfer ? 'transfer super-admin to' : edit.action} ${edit.who.realm} ${edit.who.subject}` : edit.action;
      console.warn(`hopper: sign-in changed in the UI by ${actor.realm} ${actor.subject} (${what}): applied; ${r.dropped} session(s) ended, ${r.changed} changed role`);
      return view();
    },
  };
}

export function realmRoutes(app: FastifyInstance, o: { realms: RealmsAdmin; sessions: UiSessions; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/realms', async (req): Promise<RealmsView> => {
    const s = o.sessions.find(sessionToken(req));
    if (s && !roleAllows(s.role, 'admin')) throw new HttpError(403, `role ${s.role} may not read the realms; it needs admin`);
    if (s && !o.instanceAdmin(s)) throw new HttpError(403, `${INSTANCE_ADMIN_ONLY}: read the realms`);
    return o.realms.view();
  });
}
