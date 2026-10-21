// Signing in (design.md "Sign-in: realms", issues #39, #53, #185): who a UI session belongs to,
// and what its role lets it do. The same for every realm.
import type { GrantLimits } from './grant-limits.ts';

export type { GrantLimits };

/** What a UI session may do. Each role includes the ones before it. */
export type UiRole = 'viewer' | 'operator' | 'admin';
export const UI_ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** True when `role` includes `needs`. */
export const roleAllows = (role: UiRole, needs: UiRole): boolean => UI_ROLES.indexOf(role) >= UI_ROLES.indexOf(needs);

/** The lower of two roles: what a role is capped to (an API token never acts above its minter, issue #718). */
export const lowerRole = (a: UiRole, b: UiRole): UiRole => (roleAllows(a, b) ? b : a);

/**
 * What a session is (issue #718): a person's UI session (`ui`), or an **API token** (`api`) — a short-lived session a
 * person or an agent acting for them mints, sent as `Authorization: Bearer <token>`, which Access decides at each use.
 */
export type SessionKind = 'ui' | 'api';
/** An API token starts with this, so the API door never takes it for a GitHub token and sends it to GitHub. */
export const API_TOKEN_PREFIX = 'hopper_at_';
/**
 * How long an API token lives (issue #881): the admin's setting (Users & access → API tokens), from `min` to `max` minutes,
 * `default` until set. A grant may ask for less at its mint, never more than the setting.
 */
export const API_TOKEN_MINUTES = { min: 5, max: 15, default: 10 } as const;

/** An API token as it is listed: never the token. `id`: the start of the token's hash, what a revoke names. */
/** `box`: a box token (issue #795), which alone may do box actions. */
export interface ApiTokenView { id: string; label: string; role: UiRole; box: boolean; startedAt: string; expiresAt: string; lastUsedAt: string }
/** A new API token: the token itself, answered once, in the answer that made it. */
export interface ApiTokenMinted extends ApiTokenView { token: string }

/** A refresh token starts with this (issue #881): it is neither an API token nor a sign-in's token. */
export const REFRESH_TOKEN_PREFIX = 'hopper_rt_';
/** A grant dies when no refresh used it for this many days (issue #881). */
export const GRANT_IDLE_DAYS = 30;
/** How many days a grant lives at most when its mint names none, and the most a mint may name (issue #881). */
export const GRANT_DEFAULT_DAYS = 90;
export const GRANT_MAX_DAYS = 365;
/** How long a refresh token just rotated still answers the same pair, for a refresh retried after a network blip (issue #881). */
export const REFRESH_GRACE_MS = 30_000;
/**
 * DPoP proofs (issue #892, RFC 9449, design.md "Sender binding"): a proof's `iat` may be this many seconds off the hopper's
 * clock either way; the signing algorithms a proof may name (asymmetric only); how many `jti` are kept at once.
 */
export const DPOP = { maxAgeS: 60, algorithms: ['ES256', 'ES384', 'EdDSA', 'Ed25519', 'RS256', 'PS256'], jtiMost: 10_000 } as const;
/** A key's JWK SHA-256 thumbprint (RFC 7638), as a bound grant names its agent's key (issue #892): 43 base64url characters. */
export const JKT = /^[A-Za-z0-9_-]{43}$/;

/**
 * A **grant** (issue #881) as it is listed: never a token. A person mints it once for an agent (`holder`); the agent
 * trades its refresh token for short-lived API tokens, each refresh rotating it. `scopes`: the routes its access
 * tokens may use (src/domain/token-scopes.ts). `endsAt`: null — no fixed end (an admin's choice). `idleEndsAt`: when it
 * dies if no refresh uses it. `tokenMinutes`: its own API-token lifetime, when it asked for less than the setting.
 */
export interface ApiGrantView {
  id: string; label: string; holder?: string; role: UiRole; box: boolean; scopes: string[];
  createdAt: string; endsAt: string | null; idleEndsAt: string; lastUsedAt?: string; lastUsedFrom?: string; tokenMinutes?: number;
  /** A delegate approver's (issue #1138): what its approver policy denies. Absent: no delegate approver. */
  delegate?: { deny: string[] };
  /** A bound grant's (issue #892, "Sender binding"): the thumbprint of the key its agent proves it holds at each use. */
  jkt?: string;
  /** A limited grant's (issue #892, "Grant limits"): the repositories and job sources its tokens act on. Absent: no limits. */
  limits?: GrantLimits;
}
/**
 * A new API token for a grant, and the grant's next refresh token: both answered once (issue #881). `tokenType` `DPoP`: the
 * grant is bound (issue #892): send the token as `Authorization: DPoP <token>`, with a DPoP proof.
 */
export interface ApiTokenRefreshed { grant: string; token: string; expiresAt: string; refresh: string; tokenType?: 'DPoP' }
/** A new grant: its view and its first pair (issue #881). `warning`: it has no fixed end. */
export interface ApiGrantMinted extends ApiTokenRefreshed { view: ApiGrantView; warning?: string }
/** Why a grant ended (issue #881, the `api_grant.revoked` event). */
export type GrantEndReason = 'revoked' | 'revoked-all' | 'reuse-detected' | 'expired-idle' | 'expired-absolute' | 'realm-changed' | 'refused';
export const GRANT_END_REASONS: readonly GrantEndReason[] = ['revoked', 'revoked-all', 'reuse-detected', 'expired-idle', 'expired-absolute', 'realm-changed', 'refused'];
/** A **device grant request** (issue #892): an agent asks for a grant, a person approves it. How long it waits, how often its agent polls, how many wait at once. */
export const DEVICE_GRANT = { minutes: 10, intervalS: 5, most: 50 } as const;
/** The device code an agent polls with (issue #892): this prefix and 64 hex digits, kept only as its SHA-256. */
export const DEVICE_CODE_PREFIX = 'hopper_dc_';
/** What a device grant request asks for (issue #892): the fields of a grant's mint. The person who approves it is the minter. */
export interface DeviceGrantAsk {
  label: string; holder?: string; role?: UiRole; scopes?: string[]; preset?: string; box?: boolean; days?: number | null; minutes?: number; deny?: string[];
  /** The key the grant is bound to (issue #892, "Sender binding"): the thumbprint of a DPoP proof's key. */
  jkt?: string;
  /** What the grant's tokens may act on (issue #892, "Grant limits"). */
  limits?: GrantLimits;
}
/** A device grant request just made (issue #892): the agent shows `userCode` and where to enter it, and polls with `deviceCode`. */
export interface DeviceGrantStarted { deviceCode: string; userCode: string; verificationPath: string; verificationPathComplete: string; expiresAt: string; interval: number }
/** A device grant request as a signed-in person sees it by its user code (issue #892): never its device code. `from`: who asked. */
export interface DeviceGrantView { userCode: string; ask: DeviceGrantAsk; from: string; createdAt: string; expiresAt: string }
/** The admin's API token settings (issue #881): the API-token lifetime, and its bounds. */
export interface ApiTokenSettings { tokenMinutes: number; min: number; max: number }

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

/**
 * How long a UI session lasts (issue #439), the sign-in config's `sessions`: it ends after `idleHours` without
 * a request, and `maxHours` after it started however much it is used. Read at each lookup, so a change applies
 * to the sessions there are.
 */
export interface SessionLengths { idleHours: number; maxHours: number }
export const DEFAULT_SESSION_LENGTHS: SessionLengths = { idleHours: 168, maxHours: 720 };
/** The longest a session may last: a year. */
export const MAX_SESSION_HOURS = 8760;

/**
 * Why a UI session ended (issue #439, the `ui_session.ended` event): its idle timeout or its maximum passed;
 * the gateway's token for it was refused, or its issuer stayed out of reach past the grace period; the sign-in
 * config changed under it (its realm gone or off, or no rule grants it a role); or it logged out.
 */
export type SessionEndReason = 'expired-idle' | 'expired-absolute' | 'refresh-refused' | 'provider-unreachable' | 'realm-changed' | 'connection-ended' | 'logout';
export const SESSION_END_REASONS: readonly SessionEndReason[] = ['expired-idle', 'expired-absolute', 'refresh-refused', 'provider-unreachable', 'realm-changed', 'connection-ended', 'logout'];

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
  /**
   * The session is an instance admin's (issue #240): an admin who signed in through a realm or no sign-in,
   * or a device link of a super admin's user (else, with no super admin, of the oldest user's). Only they
   * change what is the instance's; role admin alone acts inside the session's user.
   */
  instanceAdmin: boolean;
  /** The realm the session's identity signed in with. */
  realm: string;
  /** Who signed in: name, username, email or subject, the first the realm gave. */
  identity: string;
  /** The session's identity is a super admin (issue #242): it may make others super admin or hand the privilege over. */
  superAdmin: boolean;
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

/** GET /api/realms (admin): the realms in order, the first GitHub admin, the login code and no sign-in, at `version`. */
export interface RealmsView {
  version: string;
  local: boolean;
  none: UiRole | null;
  /** The first person to sign in with GitHub (issue #239): their realm, and the user they sign in as. null: nobody yet. */
  githubAdmin: { realm: string; user?: string } | null;
  /** The sign-in origin the callbacks are on. */
  origin: string;
  /** How long a UI session lasts (issue #439). */
  sessions: SessionLengths;
  realms: RealmView[];
  /** Everyone who has signed in through a realm, each identity with its role now and whether it is a super admin (issue #242). */
  people: PersonView[];
}

/**
 * One identity that has signed in through a realm (issue #242): its realm and subject (what an `admin` or
 * `super-admin` change names), the user it signs in as, the role the sign-in config grants it now (by its
 * last sign-in's details while a session of it lasts, else by its subject), and whether it is a super admin.
 */
export interface PersonView {
  realm: string;
  subject: string;
  user: string;
  role: UiRole | null;
  superAdmin: boolean;
}

/** POST /ui/api/realms: one change to the sign-in config, made against the version it read. */
export type RealmsEdit = { version: string } & (
  /** Add a realm from its fields, or replace the one named `name` (its name stays; whether it is on stays too). */
  | { action: 'save'; name?: string; realm: { name: string; label?: string; type: RealmType } & RealmSettings }
  | { action: 'remove'; name: string }
  /** Move to position `to` (0 first). */
  | { action: 'move'; name: string; to: number }
  | { action: 'enable'; name: string; enabled: boolean }
  /** Local sign-in (the login code) on or off; the role of no sign-in, or null for off; how long a session lasts. */
  | { action: 'settings'; local?: boolean; none?: UiRole | null; sessions?: SessionLengths }
  /** Make this identity admin (issue #242): any admin. */
  | { action: 'admin'; who: { realm: string; subject: string } }
  /** Make this identity a super admin, or with `transfer` hand your own super admin over to it (you stay admin): a super admin only (issue #242). */
  | { action: 'super-admin'; who: { realm: string; subject: string }; transfer?: boolean }
);

/**
 * One local account as Settings → Sign-in shows it (GET /api/local-accounts, issue #1380): never its hash. `user`: the
 * user it signs in as, once it has signed in; `passkeys`: how many passkeys it has.
 */
export interface LocalAccountView { email: string; role: UiRole; createdAt: string; user?: string; passkeys: number }

/** One of your passkeys (GET /api/local-accounts/passkeys, issue #1380): never its key. `rpId`: the host name it signs in at. */
export interface PasskeyView { id: string; name: string; rpId: string; createdAt: string; lastUsedAt?: string }

/** GET /api/local-accounts/passkeys: the passkeys of the local account the session signed in with. */
export interface PasskeysView { passkeys: PasskeyView[] }

/** GET /api/local-accounts (instance admin): every local account, by email. */
export interface LocalAccountsView { accounts: LocalAccountView[] }

/** POST /ui/api/local-accounts (instance admin): one change to the local accounts. */
export type LocalAccountsEdit =
  /** Add an account, or change one's role and, given, its password. */
  | { action: 'save'; email: string; role: UiRole; password?: string }
  | { action: 'remove'; email: string };

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
    /** A local account has a passkey (issue #1380): POST /ui/auth/passkey/options, then POST /ui/auth/passkey. */
    passkeys: boolean;
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

// The scope registry (issue #909, ./scope-registry.ts builds it): what `GET /api/scopes` answers.
/** One scope as the registry shows it. */
export interface ScopePermission {
  scope: string;
  /** What it lets an agent do, in plain words: the summaries of its routes. */
  description: string;
  /** The routes it covers: `POST /ui/api/jobs/:id/approve`. */
  routes: string[];
  /** The least UI role its routes need: a grant of a lower role gets 403 there. */
  role: UiRole;
  /** The route scope this is one action of (issue #909: `vault:edit` for `vault:edit.approve-template`); absent: a route's own. */
  parent?: string;
  /** One of its routes is a box action: only a box grant's tokens may use it. */
  box: boolean;
}

export interface ScopeSection { id: string; title: string; description: string; permissions: ScopePermission[] }

/** A named set of scopes, picked with one click or by its id (`preset` at the mint, `hopper token mint --preset`). */
export interface ScopePreset {
  id: string;
  label: string;
  /** What a grant of it can do, in plain words. */
  description: string;
  scopes: string[];
  /** Its scopes cover a box action: it is minted as a box grant. */
  box: boolean;
}

export interface ScopeRegistry { sections: ScopeSection[]; presets: ScopePreset[] }
