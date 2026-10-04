// The identity provider port (design.md "Sign-in: none, password, local, OIDC and SAML"): send the browser to the
// provider, then turn what comes back into an Identity. One implementation per auth.yaml type.
import type { Identity, IdentityProviderType } from '../domain/types.ts';

/** What the provider sends the browser back with: the callback URL (OIDC, GitHub) or form body (SAML). */
export interface ProviderCallback { url: URL; body?: Record<string, string> }

/** One sign-in in flight, as the provider left it (PKCE verifier, nonce, …). Opaque to the caller. */
export type FlowSecrets = Record<string, string>;

export interface IdentityProvider {
  name: string;
  label: string;
  type: IdentityProviderType;
  /** The URL to send the browser to; the provider carries `flowId` back (state or RelayState). */
  start(flowId: string): Promise<{ url: string; secrets: FlowSecrets }>;
  /** The flow id the provider carried back, or undefined. */
  flowIdOf(cb: ProviderCallback): string | undefined;
  /** The verified identity; throws on anything the provider or its response got wrong. */
  finish(cb: ProviderCallback, secrets: FlowSecrets): Promise<Identity>;
  /** SAML only: the service provider metadata XML for the identity provider's admin. */
  metadata?(): string;
}

/** A loopback http endpoint (a local test or dev IdP) may skip https; auth.yaml allows nothing else. */
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
