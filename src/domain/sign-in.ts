// Signing in (design.md "Sign-in: local, OIDC and SAML", issue #39): who a UI session belongs to,
// and what its role lets it do. The same for every identity provider.

/** What a UI session may do. Each role includes the ones before it. */
export type UiRole = 'viewer' | 'operator' | 'admin';
export const UI_ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** True when `role` includes `needs`. */
export const roleAllows = (role: UiRole, needs: UiRole): boolean => UI_ROLES.indexOf(role) >= UI_ROLES.indexOf(needs);

/** The identity provider types auth.yaml offers. `local` is the one-time login code. */
export type IdentityProviderType = 'oidc' | 'github' | 'saml';

/** Who signed in, as every identity provider reports it. */
export interface Identity {
  /** The provider instance name in auth.yaml (`local` for the login code). */
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

/** The signed-in user of a UI session. */
export interface SessionUser {
  role: UiRole;
  provider: string;
  /** Name, username, email or subject: the first the provider gave. */
  name: string;
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
    /** The origin a provider sign-in starts and ends on (JOB_HOPPER_PUBLIC_URL, else http://localhost:<port>). */
    origin: string;
    providers: SignInProviderView[];
  };
}
