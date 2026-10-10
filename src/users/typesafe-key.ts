// A user's Jev and TypeSafe API key (issue #657): the key is the hopper's own, kept in the vault's system scope, sealed
// under the master key, and opened at each read, so Jev's readers — the decider calls, and the gate router through the
// user's runtime secrets — use a key set, replaced or removed at once. A key the runtime still gives is imported once.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { JevChooser, User } from '../domain/types.ts';
import { createJev, createTypesafeKey, TYPESAFE_KEY_VARIABLE, type TypesafeKey } from '../minor-decisions/index.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import type { SystemSecrets } from '../vault/system.ts';

export function userTypesafeKey(o: {
  user: User; store: UserStore; env: Record<string, string | undefined>;
  /** The runtime's secrets under the user's prefix; the user's system secrets (issue #658). */
  runtime: RuntimeSecrets; system: SystemSecrets;
  seamJev?: JevChooser; timeoutMs: number; clock: Clock;
  logger: { info(line: string): void; warn(line: string): void };
}): { jev: JevChooser; typesafeKey: TypesafeKey; secret: RuntimeSecrets } {
  const { user, store, clock, logger } = o;
  const { system } = o;
  const jev = o.seamJev ?? createJev({
    python: 'python3', timeoutMs: o.timeoutMs, key: () => typesafeKey.value(),
    env: { PATH: o.env.PATH, HOME: o.env.HOME, PYTHONPATH: o.env.PYTHONPATH },
  });
  const typesafeKey = createTypesafeKey({
    system, jev, runtime: o.runtime, variable: `${user.secretPrefix}${TYPESAFE_KEY_VARIABLE}`, backfills: store.settings, clock, logger,
  });
  typesafeKey.importFromEnvironment();
  return { jev, typesafeKey, secret: (name) => (name === TYPESAFE_KEY_VARIABLE ? typesafeKey.value() : o.runtime(name)) };
}
