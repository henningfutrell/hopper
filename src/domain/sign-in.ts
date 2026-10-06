// Signing in (design.md "Sign-in: realms", issues #39, #53, #185): who a UI session belongs to,
// and what its role lets it do. The same for every realm.

/** What a UI session may do. Each role includes the ones before it. */
export type UiRole = 'viewer' | 'operator' | 'admin';
export const UI_ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** True when `role` includes `needs`. */
export const roleAllows = (role: UiRole, needs: UiRole): boolean => UI_ROLES.indexOf(role) >= UI_ROLES.indexOf(needs);

/** The realm types auth.yaml offers. `local` (the login code) and `none` (no sign-in) are not realms. */
export type RealmType = 'password' | 'ldap' | 'oidc' | 'github' | 'saml';
export const REALM_TYPES: readonly RealmType[] = ['password', 'ldap', 'oidc', 'github', 'saml'];
/** Realm types the username and password form signs in with; the others send the browser to an identity provider. */
export const FORM_REALM_TYPES: readonly RealmType[] = ['password', 'ldap'];

/** Who signed in, as every realm reports it. */
export interface Identity {
  /** The realm's name in auth.yaml (`local` the login code, `none` no sign-in). */
  realm: string;
  /** The realm's stable id for the user (account username, LDAP DN or the configured attribute, OIDC `sub`, GitHub user id, SAML NameID). */
  subject: string;
  /** Only an address the realm vouches for. */
  email?: string;
  username?: string;
  /** Shown in the UI. */
  name?: string;
  groups: string[];
}

/** Who a UI session acts for (issue #158): the user, its role, and who signed in. */
export interface SessionUser {
  /** The user the session reads and changes. */
  id: string;
  /** The user's name. */
  name: string;
  role: UiRole;
  /** The realm the session's identity signed in with. */
  realm: string;
  /** Who signed in: name, username, email or subject, the first the realm gave. */
  identity: string;
}

/** A realm the logged-out UI offers a button for (an OIDC, GitHub or SAML realm that is on). */
export interface SignInRealmView {
  name: string;
  label: string;
  type: RealmType;
}

/** One realm as Settings → Sign-in shows it (GET /api/realms): its auth.yaml entry as YAML. */
export interface RealmView {
  name: string;
  label: string;
  type: RealmType;
  enabled: boolean;
  /** The realm's entry in auth.yaml, as YAML: what the editor shows and saves. */
  entry: string;
  /** OIDC, GitHub, SAML: the callback URL to register with the identity provider. */
  callback?: string;
  /** SAML: the service provider metadata URL (also its entity id unless `entityId` is set). */
  metadata?: string;
}

/** GET /api/realms (admin): auth.yaml's realms in order, local sign-in and no sign-in, at `version`. */
export interface RealmsView {
  version: string;
  local: boolean;
  none: UiRole | null;
  /** The sign-in origin the callbacks are on. */
  origin: string;
  realms: RealmView[];
}

/** POST /ui/api/realms: one change to auth.yaml, made against the version it read. */
export type RealmsEdit = { version: string } & (
  /** Add a realm from its YAML entry, or replace the one named `name` (its name stays). */
  | { action: 'save'; name?: string; entry: string }
  | { action: 'remove'; name: string }
  /** Move to position `to` (0 first). */
  | { action: 'move'; name: string; to: number }
  | { action: 'enable'; name: string; enabled: boolean }
  /** Local sign-in (the login code) on or off; the role of no sign-in, or null for off. */
  | { action: 'settings'; local?: boolean; none?: UiRole | null }
);

/** GET /ui/api/session. */
export interface SessionView {
  authenticated: boolean;
  expiresAt?: string;
  user?: SessionUser;
  /** Logged out: the user a read without a session shows (loopback only: owner, or the one `x-hopper-user` names). */
  viewing?: { id: string; name: string };
  signIn: {
    /** The one-time login code works. */
    local: boolean;
    /** No sign-in: the role anyone gets from POST /ui/auth/none; null when off. */
    none: UiRole | null;
    /** Password sign-in (POST /ui/auth/password) is on: a password or LDAP realm is. */
    password: boolean;
    /** The origin an OIDC, GitHub or SAML sign-in starts and ends on (HOPPER_PUBLIC_URL, else http://localhost:<port>). */
    origin: string;
    /** The OIDC, GitHub and SAML realms that are on, in order. */
    realms: SignInRealmView[];
    /** Several users: the UI shows no user's work until someone signs in (issue #167). */
    required: boolean;
  };
}
