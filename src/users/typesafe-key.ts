// A user's Jev and TypeSafe API key (issue #657): the key is the hopper's own, kept in the vault's system scope, sealed
// under the token key, and opened at each read, so Jev's readers — the decider calls, and the gate router through the
// user's runtime secrets — use a key set, replaced or removed at once. A key the runtime still gives is imported once.
import { randomUUID } from 'node:crypto';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { JevChooser, User, VaultAccess } from '../domain/types.ts';
import { createJev, createTypesafeKey, TYPESAFE_KEY_VARIABLE, type TypesafeKey } from '../minor-decisions/index.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import type { SealerState } from '../secrets/sealer.ts';
import { TOKEN_KEY_VARIABLE } from '../secrets/token-box.ts';
import { createSystemSecrets } from '../vault/system.ts';

export function userTypesafeKey(o: {
  user: User; store: UserStore; env: Record<string, string | undefined>;
  /** The runtime's secrets under the user's prefix; the hopper's sealer under the token key. */
  runtime: RuntimeSecrets; keys: SealerState;
  access?: VaultAccess; seamJev?: JevChooser; timeoutMs: number; clock: Clock;
  logger: { info(line: string): void; warn(line: string): void };
}): { jev: JevChooser; typesafeKey: TypesafeKey; secret: RuntimeSecrets } {
  const { user, store, clock, logger } = o;
  const system = createSystemSecrets({ store, keys: o.keys, userId: user.id, ...(o.access ? { access: o.access } : {}), clock, idGen: randomUUID, logger });
  const jev = o.seamJev ?? createJev({
    python: 'python3', timeoutMs: o.timeoutMs, key: () => typesafeKey.value(),
    env: { PATH: o.env.PATH, HOME: o.env.HOME, PYTHONPATH: o.env.PYTHONPATH },
  });
  const typesafeKey = createTypesafeKey({
    system, jev, runtime: o.runtime, variable: `${user.secretPrefix}${TYPESAFE_KEY_VARIABLE}`, backfills: store.settings, clock, logger,
  });
  const resealed = system.resealAll();
  if (resealed > 0) logger.info(`hopper: ${resealed} system secret(s) sealed again under the current ${TOKEN_KEY_VARIABLE}`);
  typesafeKey.importFromEnvironment();
  return { jev, typesafeKey, secret: (name) => (name === TYPESAFE_KEY_VARIABLE ? typesafeKey.value() : o.runtime(name)) };
}
