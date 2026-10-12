// Sealing again on a key rotation (issues #558, #658, #718): every row of a vault's table that `mine` picks and an older
// key sealed is opened and sealed again under the current one, bound to the same place. A row that cannot be opened is
// said in the log, never with a value, and stays as it is. The vault's own secrets, the system scope and the shared
// secrets each reseal their own rows this one way.
import type { VaultRepository } from '../domain/ports.ts';
import type { Sealer } from '../secrets/sealer.ts';

/** Where a vault secret is kept: the context it is sealed for. Its id, so a fold into another user keeps it. */
export const vaultContext = (id: string): string => `vault:${id}/value`;

/** How many rows it sealed again; none without a sealer. `what` names a row in the log. */
export function resealRows(o: {
  vault: Pick<VaultRepository, 'list' | 'sealed' | 'replace'>; sealer: Sealer | undefined; mine: (name: string) => boolean; what: string; logger: { warn(line: string): void };
}): number {
  const { vault, sealer } = o;
  if (!sealer) return 0;
  let n = 0;
  for (const s of vault.list()) {
    if (!o.mine(s.name)) continue;
    const sealed = vault.sealed(s.id);
    if (sealed === undefined || sealer.current(sealed)) continue;
    try {
      vault.replace(s, sealer.seal(sealer.open(sealed, vaultContext(s.id)), vaultContext(s.id)));
      n++;
    } catch (e) {
      o.logger.warn(`hopper: ${o.what} ${s.name}: ${(e as Error).message}`);
    }
  }
  return n;
}
