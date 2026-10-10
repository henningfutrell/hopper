// The key a user's content URLs are signed under (issue #673, design.md "Artifacts"): kept in the user's vault system
// scope as `system/artifact-content-key` (issue #657), sealed under the master key, made on the first read that signs a
// URL; a restart opens it again, so a URL a viewer holds works until its own expiry. With no master key, or a stored key
// that cannot be opened, the key lives only in this process — said once in the log, and the stored one is left as it is.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { createSystemSecrets } from '../vault/system.ts';

const NAME = 'artifact-content-key';

export function userArtifactKey(o: {
  userId: string; store: Pick<UserStore, 'vault' | 'events' | 'tx'>; keys: SealerState; clock: Clock;
  logger: { warn(line: string): void };
}): () => Buffer {
  const system = createSystemSecrets({ store: o.store, keys: o.keys, userId: o.userId, clock: o.clock, idGen: randomUUID, logger: o.logger });
  let key: Buffer | undefined;
  const processOnly = (why: string): Buffer => {
    o.logger.warn(`hopper: artifacts: ${why}; content URLs end at a restart`);
    return randomBytes(32);
  };
  const load = (): Buffer => {
    const problem = system.problem();
    if (problem) return processOnly(problem);
    let kept: string | undefined;
    try {
      kept = system.open(NAME);
    } catch (e) {
      return processOnly(`the content URL key cannot be opened (${(e as Error).message})`);
    }
    if (kept !== undefined) return Buffer.from(kept, 'base64url');
    const made = randomBytes(32);
    const r = system.keep(NAME, made.toString('base64url'), 'hopper');
    return r.ok ? made : processOnly(`the content URL key cannot be kept (${r.error})`);
  };
  return () => (key ??= load());
}
