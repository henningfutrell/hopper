// Signing in (design.md "Sign-in: none, password, local, OIDC and SAML", issues #39, #53): who a UI session belongs to,
// and what its role lets it do. The same for every identity provider.

/** What a UI session may do. Each role includes the ones before it. */
export type UiRole = 'viewer' | 'operator' | 'admin';
export const UI_ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** True when `role` includes `needs`. */
export const roleAllows = (role: UiRole, needs: UiRole): boolean => UI_ROLES.indexOf(role) >= UI_ROLES.indexOf(needs);

/** The identity provider types auth.yaml offers. `local` (the login code), `none` and `password` are built in, not providers. */
export type IdentityProviderType = 'oidc' | 'github' | 'saml';

/** Who signed in, as every identity provider reports it. */
export interface Identity {
  /** The provider instance name in auth.yaml (`local` the login code, `none` no sign-in, `password` password sign-in). */
  provider: string;
  /** The provider's stable id for the user (OIDC `sub`, GitHub user id, SAML NameID). */
  subject: string;
  /** Only an address the provider vouches for. */
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
  provider: string;
  /** Who signed in: name, username, email or subject, the first the provider gave. */
  identity: string;
}

/** One way to sign in, as the logged-out UI offers it. */
export interface SignInProviderView {
  name: string;
  label: string;
  type: IdentityProviderType;
}

/** GET /ui/api/session. */
export interface SessionView {
  authenticated: boolean;
  expiresAt?: string;
  user?: SessionUser;
  signIn: {
    /** The one-time login code works. */
    local: boolean;
    /** No sign-in: the role anyone gets from POST /ui/auth/none; null when off. */
    none: UiRole | null;
    /** Password sign-in (POST /ui/auth/password) is on. */
    password: boolean;
    /** The origin a provider sign-in starts and ends on (HOPPER_PUBLIC_URL, else http://localhost:<port>). */
    origin: string;
    providers: SignInProviderView[];
  };
}
