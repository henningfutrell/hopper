// Every job repository of a user (issue #1448): the job repositories of each of their connected accounts — the first, and
// each further one —, in account order, each once. A repository is a job repository of one account at most.
import { CONNECTED_ACCOUNT_PROVIDERS, type ConnectedAccountKey } from './connected-accounts.ts';
import type { UserStore } from './store.ts';

export function everyJobRepository(store: Pick<UserStore, 'connectedAccounts' | 'settings'>): string[] {
  const keys: ConnectedAccountKey[] = [...CONNECTED_ACCOUNT_PROVIDERS, ...store.connectedAccounts.keys().filter((k) => !(CONNECTED_ACCOUNT_PROVIDERS as readonly string[]).includes(k))];
  return [...new Set(keys.flatMap((k) => store.settings.getJobRepositories(k)))];
}
