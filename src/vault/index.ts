// A user's vault, where it runs (issue #586, design.md "The vault in a container of its own"): its secrets in a container
// of their own when HOPPER_VAULT_URL names one — the hopper then holds none of the vault's keys and asks it; the templates
// stay here, with access —, else all in the hopper, under its key provider: the data key a KMS opens (HOPPER_KMS_URL), or
// the master key.
import type { Clock, CredentialMinter, UserStore } from '../domain/ports.ts';
import type { VaultAccess } from '../domain/access.ts';
import type { ConfiguredBackend } from '../domain/vault.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { vaultKeys } from './keys.ts';
import { localKms } from './kms.ts';
import { remoteVault } from './remote.ts';
import { randomUUID } from 'node:crypto';
import { createVaultService, openVault, type ClientTarget } from './service.ts';
import { localVault, withCredentialRequests, type Vault } from './vault.ts';
import type { SharedSecrets } from './shared.ts';
import { withSharedSecrets } from './shared-delivery.ts';
import { withVaultGrants } from './grants.ts';
import type { MintingOptions } from './mint.ts';

export { clientTargets } from './service.ts';
export { withLaunch, type LaunchScope } from './box.ts';
export { vaultView, type Vault } from './vault.ts';
export { approvalWait } from '../domain/vault.ts';

export async function openUserVault(o: {
  vaultUrl?: string; kms?: { url: string; key: string };
  env: Record<string, string | undefined>; user: string;
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs' | 'settings' | 'vaultGrants' | 'directJobs'>; access?: VaultAccess; clock: Clock;
  /** Mints short-lived credentials (issue #580): here, or, with a vault container, in it, which holds the minting credential. */
  minter?: CredentialMinter; logger: { info(line: string): void; warn(line: string): void };
  targets: () => ClientTarget[]; holds: (parts: ProxyTokenParts) => boolean;
  /** Whether a box step of the job runs on the machine now (issue #1004): its box asks the vault for that job. */
  stepsOn?: (jobId: string, machine: string) => boolean;
  /** The vault backends the plugins config names now (issue #585): read in the hopper, which runs them. */
  backends: () => ConfiguredBackend[];
  /** The shared secrets (issue #718), the whole hopper's: in the hopper under the master key, wherever this vault runs. Absent: none. */
  shared?: SharedSecrets;
  /** The apply gate (issue #870), wherever this vault runs: the plans are in the hopper. */
  plans?: MintingOptions['plans'];
}): Promise<Vault> {
  const vault = await open(o);
  const steps = o.stepsOn ? { stepsOn: o.stepsOn } : {};
  const shared = o.shared ? withSharedSecrets(vault, { shared: o.shared, userId: o.user, store: o.store, targets: o.targets, holds: o.holds, ...steps }) : vault;
  // Outermost (issue #652): no box job gets a vault secret, a shared secret or a minted credential without a vault grant.
  return withVaultGrants(shared, { store: o.store, clock: o.clock, targets: o.targets, holds: o.holds, ...steps });
}

async function open(o: Parameters<typeof openUserVault>[0]): Promise<Vault> {
  const secret = runtimeSecrets(o.env);
  const { shared: sharedSecrets } = o;
  const shared = {
    store: o.store, userId: o.user, ...(o.access ? { access: o.access } : {}), ...(o.minter ? { minter: o.minter } : {}), clock: o.clock, logger: o.logger, targets: o.targets, holds: o.holds, ...(o.stepsOn ? { stepsOn: o.stepsOn } : {}), backends: o.backends,
    ...(o.plans ? { plans: o.plans } : {}),
    ...(sharedSecrets ? { shared: (row: string) => sharedSecrets.get(row) } : {}),
  };
  if (o.vaultUrl) {
    const local = createVaultService({ ...shared, keys: { problem: `the vault's key is in its container, at ${o.vaultUrl}` }, idGen: randomUUID });
    return withCredentialRequests(remoteVault({ url: o.vaultUrl, secret, user: o.user, store: o.store, local, targets: o.targets, holds: o.holds }), { store: o.store, clock: o.clock, idGen: randomUUID });
  }
  const keys = await vaultKeys({ secret, ...(o.kms ? { kms: localKms(o.kms) } : {}), store: o.store.vault });
  if (o.kms && keys.problem) o.logger.warn(`hopper: ${keys.problem}: no vault secret is stored or delivered until a restart opens it`);
  return withCredentialRequests(localVault(openVault({ ...shared, keys })), { store: o.store, clock: o.clock, idGen: randomUUID });
}
