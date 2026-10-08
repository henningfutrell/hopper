// A session that ends while the UI is open (issue #439, docs/sign-in.md "Sessions and logout"): straight to
// sign-in with the realm the session was made with, then back to the page the person was on. Never a page whose
// reads and changes fail one by one.
import type { SessionView } from '../model/wire.ts';
import { loginCodeFromHash } from './login.ts';

/** How to sign in again: at the realm's identity provider, through the auth gateway (a reload), or on the landing page. */
export type Reauth = { kind: 'redirect'; realm: string } | { kind: 'gateway' } | { kind: 'landing' };

/** How the person signs in again after their session with `realm` ended, by what the hopper offers now. */
export function reauthFor(realm: string | null, offer: Pick<SessionView['signIn'], 'gateway' | 'realms' | 'devices'>): Reauth {
  if (realm === null) return { kind: 'landing' };
  if (offer.realms.some((r) => r.name === realm)) return { kind: 'redirect', realm };
  if (offer.devices.some((r) => r.name === realm && r.redirect === true)) return { kind: 'redirect', realm };
  // The gateway signs the person in again on the way to the page, and the page takes its token by itself.
  if (offer.gateway) return { kind: 'gateway' };
  return { kind: 'landing' };
}

/** The page to come back to: the view in the hash; nothing for the landing page or a login link. */
export const returnTo = (hash: string): string | null => (hash.length > 1 && loginCodeFromHash(hash) === null ? hash : null);

const RETURN_KEY = 'jh_return';

/** Keep the page to come back to, across the sign-in's round trip through the identity provider. */
export function rememberReturn(hash: string): void {
  const back = returnTo(hash);
  try { if (back) localStorage.setItem(RETURN_KEY, back); } catch { /* storage blocked: the overview after sign-in */ }
}

/** The page kept by `rememberReturn`, once. */
export function takeReturn(): string | null {
  try {
    const back = localStorage.getItem(RETURN_KEY);
    localStorage.removeItem(RETURN_KEY);
    return back === null ? null : returnTo(back);
  } catch {
    return null;
  }
}
