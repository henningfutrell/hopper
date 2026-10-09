// A user's vault, where it runs (issue #586, design.md "The vault in a container of its own"): its secrets in a container
// of their own when HOPPER_VAULT_URL names one — the hopper then holds none of the vault's keys and asks it; the templates
// stay here, with access —, else all in the hopper, under its key provider: the data key a KMS opens (HOPPER_KMS_URL), or
// the token key.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { TemplateApprovals } from '../domain/access.ts';
import type { ConfiguredBackend } from '../domain/vault.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { vaultKeys } from './keys.ts';
import { localKms } from './kms.ts';
import { remoteVault } from './remote.ts';
import { randomUUID } from 'node:crypto';
import { createVaultService, localVault, openVault, withCredentialRequests, type ClientTarget, type Vault } from './service.ts';

export { clientTargets, vaultView, type Vault } from './service.ts';

export async function openUserVault(o: {
  vaultUrl?: string; kms?: { url: string; key: string };
  env: Record<string, string | undefined>; user: string;
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings'>; access?: TemplateApprovals; clock: Clock; logger: { info(line: string): void; warn(line: string): void };
  targets: () => ClientTarget[]; holds: (parts: ProxyTokenParts) => boolean;
  /** The vault backends the plugins config names now (issue #585): read in the hopper, which runs them. */
  backends: () => ConfiguredBackend[];
}): Promise<Vault> {
  const secret = runtimeSecrets(o.env);
  const shared = { store: o.store, ...(o.access ? { access: o.access } : {}), clock: o.clock, logger: o.logger, targets: o.targets, holds: o.holds, backends: o.backends };
  if (o.vaultUrl) {
    const local = createVaultService({ ...shared, keys: { problem: `the vault's key is in its container, at ${o.vaultUrl}` }, idGen: randomUUID });
    return withCredentialRequests(remoteVault({ url: o.vaultUrl, secret, user: o.user, store: o.store, local, targets: o.targets, holds: o.holds }), { store: o.store, clock: o.clock, idGen: randomUUID });
  }
  const keys = await vaultKeys({ secret, ...(o.kms ? { kms: localKms(o.kms) } : {}), store: o.store.vault });
  if (o.kms && keys.problem) o.logger.warn(`hopper: ${keys.problem}: no vault secret is stored or delivered until a restart opens it`);
  return withCredentialRequests(localVault(openVault({ ...shared, keys })), { store: o.store, clock: o.clock, idGen: randomUUID });
}
