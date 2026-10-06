// What is the instance's — sign-in realms, adding users and their login links, updates, the plugin store,
// the users and the totals across them — is the instance admin's alone (issue #240, docs/sign-in.md "The
// instance admin"). Role `admin` alone acts inside the session's own user. There is no special admin login:
// a login code (a device link, a new user's login link) signs in with role `admin` inside its user, and is
// the instance admin's only when that user is a super admin's (their own device link) or, while no super
// admin's realm is on, the oldest user (a hopper from before). Everyone a realm makes admin — the first
// GitHub admin (issue #239), a super admin, an admin made in Settings → Sign-in → Admins (issue #242), a
// role rule's — is an instance admin; so is no sign-in's admin, which is never on with more than one user.
import type { FastifyRequest } from 'fastify';
import { isSuperAdmin, type SignIn } from '../auth/index.ts';
import type { InstanceStore } from '../domain/store.ts';
import { roleAllows } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { signedInOf } from './tenants.ts';
import type { UiSession } from './ui/sessions.ts';

/** Whether this session may do what is the instance's. */
export type InstanceAdmin = (s: Pick<UiSession, 'role' | 'identity' | 'userId'>) => boolean;

export const INSTANCE_ADMIN_ONLY = 'only the hopper\'s admin may do this: an admin who signed in with GitHub or another sign-in, not by a login link';

/** The login code's realm (src/auth LOCAL_IDENTITY): a device link or a new user's login link. */
const LOGIN_CODE = 'local';

export function createInstanceAdmin(o: { signIn: Pick<SignIn, 'config'>; instance: Pick<InstanceStore, 'users' | 'identities'> }): InstanceAdmin {
  return (s) => {
    if (!roleAllows(s.role, 'admin')) return false;
    if (s.identity.realm !== LOGIN_CODE) return true;
    const config = o.signIn.config();
    const supers = config.superAdmins.filter((a) => isSuperAdmin(config, a));
    if (supers.length === 0) return s.userId === o.instance.users.list()[0]?.id;
    return supers.some((a) => o.instance.identities.userOf(a.realm, a.subject) === s.userId);
  };
}

/**
 * An instance read (`GET /api/realms`, `/api/users`, `/api/instance`): a session or token must be an
 * instance admin's (403 naming why); loopback without either reads as before (the Host guard and the
 * tenancy hook refuse the rest). `what` names the read in the refusal.
 */
export function assertInstanceRead(req: FastifyRequest, instanceAdmin: InstanceAdmin, what: string): void {
  const s = signedInOf(req);
  if (!s) return;
  if (!roleAllows(s.role, 'admin')) throw new HttpError(403, `role ${s.role} may not ${what}; it needs admin`);
  if (!instanceAdmin(s)) throw new HttpError(403, `${INSTANCE_ADMIN_ONLY}: ${what}`);
}
