// The realm ports (design.md "Sign-in: realms"): one implementation per realm type. A redirect realm
// (oidc, github, saml) sends the browser to its identity provider, then turns what comes back into an
// Identity. A form realm (password, ldap) checks a username and password from the sign-in form.
import type { Identity, RealmType, UiRole } from '../domain/types.ts';

/** What the identity provider sends the browser back with: the callback URL (OIDC, GitHub) or form body (SAML). */
export interface RealmCallback { url: URL; body?: Record<string, string> }

/** One sign-in in flight, as the redirect realm left it (PKCE verifier, nonce, …). Opaque to the caller. */
export type FlowSecrets = Record<string, string>;

export interface RedirectRealm {
  name: string;
  label: string;
  type: RealmType;
  /** The URL to send the browser to; the identity provider carries `flowId` back (state or RelayState). */
  start(flowId: string): Promise<{ url: string; secrets: FlowSecrets }>;
  /** The flow id the identity provider carried back, or undefined. */
  flowIdOf(cb: RealmCallback): string | undefined;
  /** The verified identity; throws on anything the identity provider or its response got wrong. */
  finish(cb: RealmCallback, secrets: FlowSecrets): Promise<Identity>;
  /** SAML only: the service provider metadata XML for the identity provider's admin. */
  metadata?(): string;
}

/** What a form realm makes of a username and password. */
export type FormOutcome =
  /** The realm knows the account and the password is right. `role` null: the realm grants it none. */
  | { ok: true; who: Identity; role: UiRole | null }
  /** Unknown account or wrong password. */
  | { ok: false }
  /** The realm could not decide (its directory is unreachable, its bind failed). */
  | { ok: false; error: string };

export interface FormRealm {
  name: string;
  label: string;
  type: RealmType;
  check(username: string, password: string): Promise<FormOutcome>;
}

/** What a gateway realm makes of the token an auth gateway forwarded. */
export type GatewayOutcome =
  /** The token is valid: who it was issued to. */
  | { ok: true; who: Identity }
  /** No token, or one the realm refuses (bad signature, wrong audience, expired, not active). */
  | { ok: false; refused: string }
  /** The realm could not decide (its issuer is unreachable). */
  | { ok: false; error: string };

/** A gateway realm: an auth gateway in front of the hopper signed the person in; the realm checks the token it forwards. */
export interface GatewayRealm {
  name: string;
  label: string;
  check(headers: Record<string, string | string[] | undefined>): Promise<GatewayOutcome>;
}

/** The claim names an OIDC token or an introspection answer is read by. */
export interface ClaimNames { email: string; username: string; name: string; groups: string }

/** The Identity in a set of verified claims; `email` only when the issuer vouches for it (`email_verified`) or `trustUnverifiedEmail`. */
export function claimsIdentity(realm: string, subject: string, claims: Record<string, unknown>, names: ClaimNames, trustUnverifiedEmail: boolean): Identity {
  const email = stringOf(claims[names.email]);
  const verified = trustUnverifiedEmail || claims.email_verified === true;
  const username = stringOf(claims[names.username]);
  const name = stringOf(claims[names.name]);
  return {
    realm, subject, groups: stringList(claims[names.groups]),
    ...(email && verified ? { email } : {}), ...(username ? { username } : {}), ...(name ? { name } : {}),
  };
}

/** A loopback http endpoint (a local test or dev IdP) may skip https; the sign-in config allows nothing else. */
export const isLoopbackHttp = (u: string): boolean => {
  const x = new URL(u);
  return x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
};

/** A claim as a string list: an array of strings, or one string. */
export function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return typeof v === 'string' && v !== '' ? [v] : [];
}

export const stringOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
