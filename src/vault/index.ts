// A user's vault, where it runs (issue #586, design.md "The vault in a container of its own"): in a container of its
// own when HOPPER_VAULT_URL names one — the hopper then holds none of the vault's keys and asks it —, else in the hopper,
// under its key provider: the data key a KMS opens (HOPPER_KMS_URL), or the token key.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { vaultKeys } from './keys.ts';
import { localKms } from './kms.ts';
import { remoteVault } from './remote.ts';
import { localVault, openVault, type ClientTarget, type Vault } from './service.ts';

export { clientTargets, type Vault } from './service.ts';

export async function openUserVault(o: {
  vaultUrl?: string; kms?: { url: string; key: string };
  env: Record<string, string | undefined>; user: string;
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>; clock: Clock; logger: { info(line: string): void; warn(line: string): void };
  targets: () => ClientTarget[]; holds: (parts: ProxyTokenParts) => boolean;
}): Promise<Vault> {
  const secret = runtimeSecrets(o.env);
  if (o.vaultUrl) return remoteVault({ url: o.vaultUrl, secret, user: o.user, store: o.store, targets: o.targets, holds: o.holds });
  const keys = await vaultKeys({ secret, ...(o.kms ? { kms: localKms(o.kms) } : {}), store: o.store.vault });
  if (o.kms && keys.problem) o.logger.warn(`hopper: ${keys.problem}: no vault secret is stored or delivered until a restart opens it`);
  return localVault(openVault({ store: o.store, keys, clock: o.clock, logger: o.logger, targets: o.targets, holds: o.holds }));
}
