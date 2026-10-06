// The hopper's app (issue #214, design.md "Sign in with GitHub, and work through that connection"): one
// GitHub App, registered once and shipped with the hopper. People sign in through it and their jobs work
// through it; GitHub marks the app on what they do. It ships only its public client id and its public
// slug (for the install link): the device flow (RFC 8628) needs no secret, so no private key or client
// secret is distributed. An install may name another app, or a GitHub Enterprise, through the environment
// (HOPPER_GITHUB_URL, HOPPER_GITHUB_CLIENT_ID, HOPPER_GITHUB_APP_SLUG). Not an admin's own GitHub App,
// which acts as itself with its private key (the github-app job source).
import type { ConnectedAccountProvider } from '../domain/types.ts';

/** What the hopper ships. Public by design: a client id names the app, it authorizes nothing. */
export const SHIPPED_APPS: Record<ConnectedAccountProvider, { clientId: string; slug?: string }> = {
  github: { clientId: 'Iv23liKJ2NjhKAsv0JxL', slug: 'hopper-qm' },
};

export const DEFAULT_URLS: Record<ConnectedAccountProvider, string> = { github: 'https://github.com' };

/** Where GitHub's sign-in flow and API are reached, and the app's public identity. */
export interface HopperApp {
  provider: ConnectedAccountProvider;
  /** GitHub's web origin: https://github.com, or a GitHub Enterprise's. */
  url: string;
  /** The REST API base: api.github.com for github.com, `<url>/api/v3` for GitHub Enterprise. */
  apiUrl: string;
  /** Empty: this hopper has no app; signing in or connecting says which variable names one. */
  clientId: string;
  /** The app's slug, for its install link; absent: none to show. */
  slug?: string;
}

export type HopperApps = Record<ConnectedAccountProvider, HopperApp>;

export const CLIENT_ID_VARIABLE: Record<ConnectedAccountProvider, string> = { github: 'HOPPER_GITHUB_CLIENT_ID' };

/** The GitHub App's install page: it reaches only the repositories it is installed on. */
export const installUrl = (app: HopperApp): string | undefined => (app.slug ? `${app.url}/apps/${app.slug}/installations/new` : undefined);

export function hopperApps(o: { github: { url?: string; clientId?: string; slug?: string } }): HopperApps {
  const url = (o.github.url ?? DEFAULT_URLS.github).replace(/\/+$/, '');
  const slug = o.github.slug ?? SHIPPED_APPS.github.slug;
  return {
    github: {
      provider: 'github', url, apiUrl: url === DEFAULT_URLS.github ? 'https://api.github.com' : `${url}/api/v3`,
      clientId: o.github.clientId ?? SHIPPED_APPS.github.clientId, ...(slug ? { slug } : {}),
    },
  };
}
