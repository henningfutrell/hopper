// What is the instance's — sign-in realms, adding users and their login links, updates, the plugin store,
// the users and the totals across them — is the hopper's admin's alone (issue #240, docs/sign-in.md "The
// instance admin"): an admin session of the user the first GitHub admin signs in as (issue #239), else of
// the oldest user. Role admin alone acts inside the session's own user; a login code never makes this admin.
import { instanceAdminUser, type SignIn } from '../auth/index.ts';
import type { InstanceStore } from '../domain/store.ts';
import { roleAllows } from '../domain/types.ts';
import type { UiSession } from './ui/sessions.ts';

/** Whether this session may do what is the instance's. */
export type InstanceAdmin = (s: Pick<UiSession, 'role' | 'userId'>) => boolean;

export const INSTANCE_ADMIN_ONLY = 'only the hopper\'s admin (the first person to sign in with GitHub) may do this';

export function createInstanceAdmin(o: { signIn: Pick<SignIn, 'config'>; instance: Pick<InstanceStore, 'users' | 'identities'> }): InstanceAdmin {
  return (s) => roleAllows(s.role, 'admin')
    && s.userId === instanceAdminUser(o.signIn.config(), (realm, subject) => o.instance.identities.userOf(realm, subject), o.instance.users.list()[0]?.id);
}
