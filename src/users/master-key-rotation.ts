// The master key rotation, composed (issue #659 requirement 6, design.md "Rotating the master key"): the instance store
// seals every secret again under the new key in one transaction over every schema; then the log mask holds the new key,
// and every part reads it — each sealer reads the key at each call (src/secrets/sealer.ts liveSealer) —, so the running
// hopper goes on under it with no restart. One line in the log and one event in every user's log, never a key. Not with
// the vault in a container of its own: that process keeps the key it was started with.
import type { InstanceStore, MasterKeyResealed } from '../domain/ports.ts';
import type { NewEvent } from '../domain/types.ts';
import type { LogMask } from '../secrets/log-mask.ts';
import { fingerprintOf, shortFingerprint, type KeyedEnv } from '../secrets/master-key.ts';

type Rotation = (o: { from: { key: string; previous: readonly string[] }; to: string; by: string }) => MasterKeyResealed;

export function masterKeyRotation(o: {
  store: Pick<InstanceStore, 'rotateMasterKey'>; keyed: Pick<KeyedEnv, 'use'>; mask: Pick<LogMask, 'hold'>; vaultUrl: string | undefined;
  logger: { warn(line: string): void }; append: (e: NewEvent) => void;
}): Rotation | { why: string } {
  if (o.vaultUrl) return { why: 'the master key cannot be rotated here while the vault runs in a container of its own (HOPPER_VAULT_URL): that container keeps the key it started with. Rotate it at launch (docs/deploy.md "Rotating the master key")' };
  return (r) => {
    const done = o.store.rotateMasterKey(r);
    o.mask.hold(r.to);
    o.keyed.use({ key: r.to, previous: [] });
    const [from, to] = [r.from.key, r.to].map((k) => shortFingerprint(fingerprintOf(k))) as [string, string];
    o.logger.warn(`hopper: the master key was rotated by ${r.by} (fingerprint ${from} → ${to}): ${done.resealed} secret(s) sealed again under it${done.unreadable ? `; ${done.unreadable} that did not open left as they were` : ''}. Give the new key as HOPPER_MASTER_KEY before the next start: a start with the old one is refused`);
    o.append({ type: 'vault.master_key_rotated', data: { from, to, by: r.by, ...done } });
    return done;
  };
}
