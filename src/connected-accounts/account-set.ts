// A user's connected accounts, more than one at a provider (issue #1448, design.md "More than one GitHub account"): the
// first account, keyed by its provider (`github`), connects as before — a sign-in with GitHub, a device code, or a personal
// access token —; a further account (`github-2`, `github-3`, …) is added with a personal access token of its own. Each is
// one connected-accounts service (service.ts) over its own key's view of the store and the vault (keyed.ts): its row, its
// tokens, the repositories it reaches, its job repositories, its renewal, its email match and its end are its own. A
// further account that ends marks only itself.
//
// A repository is a job repository of one account at most: the account that acts for a job of it, its git and its source
// (`keyFor`). Any other repository is the first account's.
import type { ConnectedAccounts, ConnectedAccountTokens } from '../domain/ports.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, CONNECTED_VIA, furtherAccount, providerOfKey, type ConnectedAccountKey, type ConnectedAccountProvider, type ConnectedAccountStatus } from '../domain/types.ts';
import { PROVIDER_NAME } from './at-rest.ts';
import { keyedSecrets, keyedStore } from './keyed.ts';
import { createConnectedAccounts, type ConnectedAccountsOptions, type ConnectedAccountsService } from './service.ts';

/** A repository chosen for another account's jobs (issue #1448): the route answers 409. */
export class RepositoryTaken extends Error {}

export type AccountSet = ConnectedAccounts & ConnectedAccountTokens & {
  /** The account whose job repositories hold `repo` (any case); none does, or no repository: the first account. */
  keyFor(repo: string | undefined): ConnectedAccountKey;
  start(): void;
  renewDue(): Promise<void>;
  stop(): void;
};

const number = (key: ConnectedAccountKey): number => (furtherAccount(key) ? Number(key.slice(key.lastIndexOf('-') + 1)) : 1);

export function createAccountSet(o: ConnectedAccountsOptions): AccountSet {
  /** A repository another account than `key` has for its jobs (issue #2795): never a new repository of `key`. */
  const takenBy = (key: ConnectedAccountKey) => (repo: string): boolean => keys().some((k) => k !== key && at(k)[0].jobRepositories(providerOfKey(k)).some((r) => same(r, repo)));
  const first = createConnectedAccounts({ ...o, taken: takenBy('github') });
  const further = new Map<ConnectedAccountKey, ConnectedAccountsService>();
  const make = (key: ConnectedAccountKey): ConnectedAccountsService => {
    const provider = providerOfKey(key);
    // A further account is never a sign-in: nothing links it to an identity, and nothing hands it a sign-in's grant.
    const { link: _link, ...rest } = o;
    return createConnectedAccounts({
      ...rest, accountKey: key, taken: takenBy(key), store: keyedStore(o.store, provider, key), secrets: keyedSecrets(o.secrets, provider, key),
      ...(o.onChange ? { onChange: () => o.onChange!(key) } : {}),
      ...(o.onExpired ? { onExpired: (_p, account, reason) => o.onExpired!(key, account, reason) } : {}),
      ...(o.onRenewed ? { onRenewed: (_p, renewed) => o.onRenewed!(key, renewed) } : {}),
      ...(o.onRenewalFailed ? { onRenewalFailed: (_p, failed) => o.onRenewalFailed!(key, failed) } : {}),
      ...(o.onNewRepositories ? { onNewRepositories: (_p, found) => o.onNewRepositories!(key, found) } : {}),
    });
  };
  let started = false;
  /** Keys being added now: `follow` leaves them to `add`. */
  const adding = new Set<ConnectedAccountKey>();
  /**
   * The further accounts as the store keeps them now: another process on the same database may have added or removed one.
   * A row this process does not know gets its service; a service whose row is gone stops.
   */
  const follow = (): void => {
    const kept = new Set(o.store.connectedAccounts.keys().filter(furtherAccount));
    for (const key of kept) if (!further.has(key) && !adding.has(key)) { const s = make(key); further.set(key, s); if (started) s.start(); }
    for (const [key, s] of further) if (!kept.has(key)) { s.stop(); further.delete(key); }
  };
  follow();

  const keys = (): ConnectedAccountKey[] => { follow(); return [...CONNECTED_ACCOUNT_PROVIDERS, ...[...further.keys()].sort((a, b) => number(a) - number(b))]; };
  /** The service of `key` and the provider it answers as. Throws for a key not connected here. */
  const at = (key: ConnectedAccountKey): [ConnectedAccountsService, ConnectedAccountProvider] => {
    if (furtherAccount(key) && !further.has(key)) follow();
    const s = furtherAccount(key) ? further.get(key) : first;
    if (!s) throw new Error(`no connected account ${key}: Sources → add it`);
    return [s, providerOfKey(key)];
  };
  /** A further account removed (or never added): what its source, which finishes its own jobs, is told. */
  const gone = (key: ConnectedAccountKey): string | undefined => {
    if (!furtherAccount(key) || further.has(key)) return undefined;
    follow();
    return further.has(key) ? undefined : `${PROVIDER_NAME[providerOfKey(key)]} account ${key} was removed: Sources → Add another ${PROVIDER_NAME[providerOfKey(key)]} account`;
  };
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const keyFor = (repo: string | undefined): ConnectedAccountKey => {
    if (repo !== undefined) for (const key of keys()) if (at(key)[0].jobRepositories(providerOfKey(key)).some((r) => same(r, repo))) return key;
    return 'github';
  };
  /** The next free key at `provider`: the smallest number from 2 no account holds. */
  const nextKey = (provider: ConnectedAccountProvider): ConnectedAccountKey => {
    let n = 2;
    while (further.has(`${provider}-${n}`) || o.store.connectedAccounts.get(`${provider}-${n}`)) n += 1;
    return `${provider}-${n}`;
  };
  const failed = (provider: ConnectedAccountProvider, key: ConnectedAccountKey, error: string): ConnectedAccountStatus => {
    o.logger.warn(`hopper: adding a ${PROVIDER_NAME[provider]} account refused: ${error}`);
    return { provider, key, via: CONNECTED_VIA, state: 'failed', error };
  };
  const forget = async (key: ConnectedAccountKey, s: ConnectedAccountsService, provider: ConnectedAccountProvider): Promise<void> => {
    await s.disconnect(provider);
    s.stop();
    further.delete(key);
    o.store.settings.setJobRepositories(key, []); // a key used again later starts with none
  };

  return {
    keys, keyFor,
    async status() {
      const all = await Promise.all(keys().map(async (key) => {
        const [s, provider] = at(key);
        return (await s.status()).filter((x) => x.provider === provider);
      }));
      return all.flat();
    },
    refresh: (key) => { const [s, p] = at(key); return s.refresh(p); },
    adopt: (connection) => first.adopt(connection),
    connect: (key, by) => { const [s, p] = at(key); return s.connect(p, by); },
    connectToken: (key, token, by) => { const [s, p] = at(key); return s.connectToken(p, token, by); },
    async add(provider, token, by) {
      if (!first.account(provider) && !first.ended(provider) && !first.expired(provider)) return first.connectToken(provider, token, by);
      const key = nextKey(provider);
      let login: string;
      try { login = (await o.whoIs(provider, token)).account; } catch (err) { return failed(provider, key, `${PROVIDER_NAME[provider]} refused the token: ${(err as Error).message}`); }
      const held = keys().filter((k) => providerOfKey(k) === provider).find((k) => o.store.connectedAccounts.get(k)?.account.toLowerCase() === login.toLowerCase());
      if (held) return failed(provider, key, `${PROVIDER_NAME[provider]} account ${login} is connected already (${held}): a further account is another ${PROVIDER_NAME[provider]} account`);
      const s = make(key);
      adding.add(key);
      const status = await s.connectToken(provider, token, by).finally(() => adding.delete(key));
      if (status.state !== 'connected') { s.stop(); return status; } // nothing kept: the key stays free
      further.set(key, s);
      if (started) s.start();
      o.logger.info(`hopper: ${PROVIDER_NAME[provider]} account ${login} added as ${key}`);
      o.onChange?.(key); // now that it is one of the keys: its job source starts
      return status;
    },
    cancel: (key) => { const [s, p] = at(key); return s.cancel(p); },
    takeHeld: (key) => { const [s, p] = at(key); return s.takeHeld(p); },
    dropHeld: (key) => { const [s, p] = at(key); return s.dropHeld(p); },
    expired: (key) => { if (gone(key)) return false; const [s, p] = at(key); return s.expired(p); },
    async disconnect(key) {
      const [s, provider] = at(key);
      if (!furtherAccount(key)) return s.disconnect(provider);
      const login = s.account(provider);
      await forget(key, s, provider);
      o.logger.info(`hopper: ${PROVIDER_NAME[provider]} account ${login ?? key} removed (${key})`);
      o.onChange?.(key); // no longer one of the keys: its job source stops
      return { provider, key, via: CONNECTED_VIA, state: 'not-connected' };
    },
    choose(key, repositories) {
      const [s, provider] = at(key);
      const taken = keys().filter((k) => k !== key).flatMap((k) => at(k)[0].jobRepositories(providerOfKey(k)).filter((r) => repositories.some((x) => same(x, r))).map((r) => `${r} (${k})`));
      if (taken.length > 0) return Promise.reject(new RepositoryTaken(`a repository is a job repository of one account only; chosen for another account already: ${taken.join(', ')}`));
      return s.choose(provider, repositories);
    },
    newRepositories: (key, change) => { const [s, p] = at(key); return s.newRepositories(p, change); },
    // What a job source asks: a removed account reads as ended, with no repositories, never as an error.
    account: (key) => { if (gone(key)) return undefined; const [s, p] = at(key); return s.account(p); },
    ended: (key) => { const why = gone(key); if (why) return why; const [s, p] = at(key); return s.ended(p); },
    token: (key) => { const why = gone(key); if (why) return Promise.reject(new Error(why)); const [s, p] = at(key); return s.token(p); },
    renew: (key, refused) => { const why = gone(key); if (why) return Promise.reject(new Error(why)); const [s, p] = at(key); return s.renew(p, refused); },
    endpoints: (key) => first.endpoints(providerOfKey(key)),
    jobRepositories: (key) => { if (gone(key)) return []; const [s, p] = at(key); return s.jobRepositories(p); },
    start() { started = true; first.start(); for (const s of further.values()) s.start(); },
    async renewDue() { await Promise.all([first, ...further.values()].map((s) => s.renewDue())); },
    stop() { started = false; first.stop(); for (const s of further.values()) s.stop(); },
  };
}

