// A further connected account's own view of the user's store and vault (issue #1448, design.md "More than one GitHub
// account"): the connected-accounts service of one account keeps its row, its tokens, where its app is installed (or what its
// token reaches) and its job repositories under the account's key, never under its provider. The first account's key is its
// provider, so its view is the store itself and what was kept before stays as it was.
import type { UserStore } from '../domain/ports.ts';
import type { ConnectedAccountKey, ConnectedAccountProvider } from '../domain/types.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import type { SystemSecrets } from '../vault/system.ts';

export type AccountStore = Pick<UserStore, 'connectedAccounts' | 'settings' | 'tx' | 'appInstallations'>;

/** A port's methods by provider, not by key: what one account's service answers (service.ts). */
export type ByProvider<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer O ? A extends [ConnectedAccountKey, ...infer R] ? (provider: ConnectedAccountProvider, ...rest: R) => O : T[K] : T[K];
};

/** The store as the account `key` at `provider` sees it: its provider's places are the key's. */
export function keyedStore(store: AccountStore, provider: ConnectedAccountProvider, key: ConnectedAccountKey): AccountStore {
  if (key === provider) return store;
  const k = (p: string): ConnectedAccountKey => (p === provider ? key : p as ConnectedAccountKey);
  const a = store.connectedAccounts, i = store.appInstallations, s = store.settings;
  return {
    tx: (fn) => store.tx(fn),
    connectedAccounts: {
      get: (p) => a.get(k(p)), put: (row) => a.put(row, key), keys: () => [key].filter((x) => a.get(x) !== undefined),
      lockRow: (p) => a.lockRow(k(p)), legacyTokens: (p) => a.legacyTokens(k(p)), dropLegacyTokens: (p) => a.dropLegacyTokens(k(p)),
      lock: (p) => a.lock(k(p)), unlock: (p) => a.unlock(k(p)), delete: (p) => a.delete(k(p)),
    },
    appInstallations: { get: (p) => i.get(k(p)), put: (read) => i.put(read, key), remove: (p) => i.remove(k(p)) },
    settings: { ...s, getJobRepositories: (p) => s.getJobRepositories(k(p)), setJobRepositories: (p, repos) => s.setJobRepositories(k(p), repos),
      getNewRepositories: (p) => s.getNewRepositories(k(p)), setNewRepositories: (p, r) => s.setNewRepositories(k(p), r) },
  };
}

/** The vault as the account `key` sees it: its tokens are `connected-account.<key>.…`. Every other name is as it is. */
export function keyedSecrets(secrets: SystemSecrets, provider: ConnectedAccountProvider, key: ConnectedAccountKey): SystemSecrets {
  if (key === provider) return secrets;
  const from = `connected-account.${provider}.`;
  const n = (name: SystemSecretName): SystemSecretName => (name.startsWith(from) ? `connected-account.${key}.${name.slice(from.length)}` as SystemSecretName : name);
  return {
    ...secrets,
    open: (name, purpose) => secrets.open(n(name), purpose),
    stored: (name) => secrets.stored(n(name)),
    meta: (name) => secrets.meta(n(name)),
    set: (name, value, who) => secrets.set(n(name), value, who),
    remove: (name, who) => secrets.remove(n(name), who),
    keep: (name, value, by, how) => secrets.keep(n(name), value, by, how),
    drop: (name, by) => secrets.drop(n(name), by),
    keepInBackend: (name, backend, reference, who) => secrets.keepInBackend(n(name), backend, reference, who),
    keptIn: (name) => secrets.keptIn(n(name)),
    migrate: (name, value, from) => secrets.migrate(n(name), value, from),
  };
}
