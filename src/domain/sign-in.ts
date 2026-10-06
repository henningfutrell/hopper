// Signing in (design.md "Sign-in: realms", issues #39, #53, #185): who a UI session belongs to,
// and what its role lets it do. The same for every realm.

/** What a UI session may do. Each role includes the ones before it. */
export type UiRole = 'viewer' | 'operator' | 'admin';
export const UI_ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** True when `role` includes `needs`. */
export const roleAllows = (role: UiRole, needs: UiRole): boolean => UI_ROLES.indexOf(role) >= UI_ROLES.indexOf(needs);

/** The realm types the sign-in config offers. `local` (the login code) and `none` (no sign-in) are not realms. */
export type RealmType = 'ldap' | 'oidc' | 'github' | 'saml' | 'gateway';
export const REALM_TYPES: readonly RealmType[] = ['ldap', 'oidc', 'github', 'saml', 'gateway'];
/** Realm types the username and password form signs in with: a directory's, never an account of the hopper's own (issue #237). */
export const FORM_REALM_TYPES: readonly RealmType[] = ['ldap'];
/** Realm types that send the browser to an identity provider. A `gateway` realm is neither: an auth gateway in front of the hopper signed the person in. */
export const REDIRECT_REALM_TYPES: readonly RealmType[] = ['oidc', 'saml'];
/**
 * Realm types the person signs in with by a device code entered at the provider, through the hopper's
 * app (issue #214): GitHub, through its GitHub App. The token that signs them in is also their connected
 * account: what their jobs work through.
 */
export const DEVICE_REALM_TYPES: readonly RealmType[] = ['github'];

/** Who signed in, as every realm reports it. */
export interface Identity {
  /** The realm's name in the sign-in config (`local` the login code, `none` no sign-in). */
  realm: string;
  /** The realm's stable id for the user (LDAP DN or the configured attribute, OIDC `sub`, GitHub user id, SAML NameID). */
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
  /** A GitHub realm (issue #258): the browser can go to GitHub and back on the sign-in origin (the runtime gives the app's client secret); else the device code. */
  redirect?: boolean;
}

/**
 * A realm type's settings, by field (`issuer`, `clientId`, `attributes: { email }`, `roles`, …; every one:
 * docs/sign-in.md). Read back, never a secret (`RealmView.secrets` names those set); saved, a secret
 * (`clientSecret`, `bindPassword`) left out keeps the stored one and `null` removes it (issue #216).
 */
export type RealmSettings = { [field: string]: unknown };

/** One realm as Settings → Sign-in shows it (GET /api/realms). */
export interface RealmView {
  name: string;
  label: string;
  type: RealmType;
  enabled: boolean;
  /** Its type's settings: what the realm's form shows and saves. Never a secret. */
  settings: RealmSettings;
  /** The secret settings that are set (`clientSecret`, `bindPassword`); their values are never answered. */
  secrets: string[];
  /** Set up by HOPPER_SIGN_IN_REALM_<NAME>_* variables: the next start sets it from them again (issue #216). */
  environment?: boolean;
  /** OIDC, SAML: the callback URL to register with the identity provider. */
  callback?: string;
  /** SAML: the service provider metadata URL (also its entity id unless `entityId` is set). */
  metadata?: string;
}

/** GET /api/realms (admin): the realms in order, the login code and no sign-in, at `version`. */
export interface RealmsView {
  version: string;
  local: boolean;
  none: UiRole | null;
  /** The sign-in origin the callbacks are on. */
  origin: string;
  realms: RealmView[];
}

/** POST /ui/api/realms: one change to the sign-in config, made against the version it read. */
export type RealmsEdit = { version: string } & (
  /** Add a realm from its fields, or replace the one named `name` (its name stays; whether it is on stays too). */
  | { action: 'save'; name?: string; realm: { name: string; label?: string; type: RealmType } & RealmSettings }
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
  /** Logged out: the user a read without a session shows (loopback on a one-user hopper only: that user). */
  viewing?: { id: string; name: string };
  signIn: {
    /** The one-time login code works. */
    local: boolean;
    /** No sign-in: the role anyone gets from POST /ui/auth/none; null when off. */
    none: UiRole | null;
    /** Password sign-in (POST /ui/auth/password) is on: an LDAP realm is. */
    password: boolean;
    /** A gateway realm is on: POST /ui/auth/gateway turns the token the auth gateway forwards into a session. */
    gateway: boolean;
    /** The origin an OIDC, GitHub or SAML sign-in starts and ends on (HOPPER_PUBLIC_URL, else http://localhost:<port>). */
    origin: string;
    /** The OIDC, GitHub and SAML realms that are on, in order. */
    realms: SignInRealmView[];
    /** The GitHub realms that are on, in order: each a "Sign in with" button — to GitHub and back when `redirect`, else showing a device code (issues #214, #258). */
    devices: SignInRealmView[];
    /** Several users: the UI shows no user's work until someone signs in (issue #167). */
    required: boolean;
  };
}
