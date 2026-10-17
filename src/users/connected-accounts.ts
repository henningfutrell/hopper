// A user's connected accounts, as their runtime makes them (issues #214, #1448): the GitHub account their work comes through
// — from signing in with it, or connected from Sources, through the hopper's app or a personal access token — and each further
// GitHub account, added with a token of its own. Their job sources and jobs ask here for tokens.
import { createAccountSet, type AccountSet } from '../connected-accounts/account-set.ts';
import type { HopperApps } from '../connected-accounts/hopper-app.ts';
import { installations, tokenRepositories, whoIs } from '../connected-accounts/identity.ts';
import { accountEvents, fromRuntime, type ConnectedAccountsOptions } from '../connected-accounts/service.ts';
import type { ConnectedAccountKey, ConnectedAccountProvider } from '../domain/types.ts';

export function userAccounts(o: Pick<ConnectedAccountsOptions, 'store' | 'clock' | 'logger' | 'secrets'> & {
  apps: HopperApps; env: Record<string, string | undefined>; events: Parameters<typeof accountEvents>[0];
  link?: ((provider: ConnectedAccountProvider, subject: string) => void) | undefined; sourceEmailMatch?: (() => boolean) | undefined;
  /** An account connected, disconnected, added or removed: its job source syncs now; a further one's comes or goes. */
  onChange(key: ConnectedAccountKey): void;
}): AccountSet {
  return createAccountSet({
    // GitHub App user tokens expire after 8 h (issues #358, #441): renewed with the refresh token, sealed at rest.
    store: o.store, apps: o.apps, clock: o.clock, logger: o.logger, ...fromRuntime(o.apps, o.env), secrets: o.secrets,
    whoIs: (provider, token) => whoIs(o.apps[provider], token),
    installations: (token, answers) => installations(o.apps.github, token, answers), tokenRepositories: (token, answers) => tokenRepositories(o.apps.github, token, answers), // a personal access token's (issue #1380)
    // Its end, each renewal and each failed renewal are recorded (issues #358, #647), never with a token.
    ...accountEvents(o.events),
    ...(o.link ? { link: o.link } : {}), ...(o.sourceEmailMatch ? { sourceEmailMatch: o.sourceEmailMatch } : {}),
    onChange: o.onChange,
  });
}
