// The vault's key provider, chosen (issue #586, design.md "The KMS: an optional key provider"). No KMS: the sealer under
// the token key (issue #558). A KMS: the sealer under the user's data key — made and wrapped by the KMS once, kept
// wrapped in the user's store, opened by the KMS at each start — with the token keys as previous keys, so a vault
// secret sealed before the KMS still opens and is sealed again under the data key. A KMS that gives no data key leaves
// the vault with no sealer and a problem naming the KMS: nothing is stored, nothing opened (fails closed).
import type { VaultRepository } from '../domain/ports.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { createSealer, PREVIOUS_KEYS_VARIABLE, sealerOf, type SealerState } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';
import type { KeyService } from './kms.ts';

export async function vaultKeys(o: { secret: RuntimeSecrets; kms?: KeyService; store: Pick<VaultRepository, 'dataKey' | 'keepDataKey'> }): Promise<SealerState> {
  const local = sealerOf(o.secret);
  if (!o.kms) return local;
  const previous = [o.secret(TOKEN_KEY_VARIABLE) ?? '', ...(o.secret(PREVIOUS_KEYS_VARIABLE) ?? '').split(/[\s,]+/)].filter(Boolean);
  let plain: Buffer | undefined;
  try {
    const kept = o.store.dataKey();
    if (kept !== undefined) plain = await o.kms.unwrap(kept);
    else {
      const made = await o.kms.newDataKey();
      // Two starts at once: the first to keep its data key wins; the other opens that one.
      if (o.store.keepDataKey(made.wrapped)) plain = made.plain;
      else {
        made.plain.fill(0);
        plain = await o.kms.unwrap(o.store.dataKey()!);
      }
    }
    return { sealer: createSealer(plain.toString('hex'), previous) };
  } catch (e) {
    return { problem: `the KMS at ${o.kms.url} gives the vault no data key (${(e as Error).message})` };
  } finally {
    plain?.fill(0);
  }
}
