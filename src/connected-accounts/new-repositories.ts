// New repositories the app comes to reach (issue #2761, design.md "New repositories the app comes to reach"): a repository a
// read of the installations finds new — the app installed on a new owner, or a repository added to an installation —
// becomes a job repository of the account, and its job source syncs at once. Not one chosen already, not one another of
// the user's accounts holds, and never one a personal access token came to reach: the token reaches every repository its
// user does.
import type { ConnectedAccountProvider, ConnectedAccountKey } from '../domain/types.ts';
import type { UserStore } from '../domain/ports.ts';
import { PROVIDER_NAME } from './at-rest.ts';

export interface NewRepositoriesOptions {
  settings: Pick<UserStore['settings'], 'getJobRepositories' | 'setJobRepositories'>;
  /** Whether the account connected with a personal access token, or is not live: nothing is taken. */
  skip(provider: ConnectedAccountProvider): boolean;
  takenElsewhere?(provider: ConnectedAccountProvider, repo: string): boolean;
  logger: { info(line: string): void };
  onChange?(key: ConnectedAccountKey): void;
}

/** Makes `repositories` job repositories of the account where it may; answers those it made. */
export const newRepositories = (o: NewRepositoriesOptions) => (provider: ConnectedAccountProvider, repositories: string[]): string[] => {
  if (o.skip(provider)) return [];
  const chosen = o.settings.getJobRepositories(provider);
  const fresh = repositories.filter((r) => !chosen.some((c) => c.toLowerCase() === r.toLowerCase()) && !o.takenElsewhere?.(provider, r));
  if (fresh.length === 0) return [];
  o.settings.setJobRepositories(provider, [...chosen, ...fresh]);
  o.logger.info(`hopper: ${PROVIDER_NAME[provider]}: ${fresh.length} new repositories the app reaches added for jobs: ${fresh.join(', ')}`);
  o.onChange?.(provider);
  return fresh;
};
