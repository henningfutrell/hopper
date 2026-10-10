// The whole hopper's part of the vault's system scope (issue #658, design.md "The vault's system scope"): the sign-in
// realms' secrets, in the instance's vault. At the daemon's start, before the sign-in config is read: the secrets the
// `sign-in` record still holds (from before #658, or written by the operator CLI) move into the vault — kept, opened
// again, then removed from the record, one `vault.secret_migrated` each —, an older key's are sealed again, and the
// start check names a missing key. The instance has no event log of its own: its events wait until the users' runtimes
// exist, then go to every user's (InstanceEvents), as the update events do.
import { randomUUID } from 'node:crypto';
import type { Clock, InstanceStore } from '../domain/ports.ts';
import type { NewEvent } from '../domain/types.ts';
import { sealedSignIn, secretsIn, withoutSecrets } from '../auth/sealed-secrets.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { sealerOf } from '../secrets/sealer.ts';
import { MASTER_KEY_VARIABLE } from '../secrets/token-box.ts';
import { createSystemSecrets, type SystemSecrets } from '../vault/system.ts';

interface Logger { info(line: string): void; warn(line: string): void }

export interface InstanceSecrets {
  /** The instance store with its sign-in config over the vault. */
  instance: InstanceStore;
  system: SystemSecrets;
  /** From now on the events go to `sink`; those made before it, first. */
  connect(sink: (e: NewEvent) => void): void;
}

/**
 * `migrate`: move the secrets the record holds now (the daemon; never the operator CLI, beside a running one). A move that
 * fails closes the store and throws: the daemon does not start on a half-moved sign-in config.
 */
export function openInstanceSecrets(store: InstanceStore, o: { env: Record<string, string | undefined>; clock: Clock; logger: Logger; migrate?: boolean }): InstanceSecrets {
  try {
    return open(store, o);
  } catch (e) {
    if (o.migrate) store.close();
    throw e;
  }
}

function open(store: InstanceStore, o: { env: Record<string, string | undefined>; clock: Clock; logger: Logger; migrate?: boolean }): InstanceSecrets {
  const keys = sealerOf(runtimeSecrets(o.env));
  const waiting: NewEvent[] = [];
  let sink: ((e: NewEvent) => void) | undefined;
  const events = { append: (e: NewEvent) => { if (sink) sink(e); else waiting.push(e); } };
  const system = createSystemSecrets({
    store: { vault: store.vault, events, tx: store.tx }, keys, userId: 'instance', scope: 'instance', clock: o.clock, idGen: randomUUID, logger: o.logger,
  });
  const raw = store.signInConfig;
  if (o.migrate) {
    const record = raw.read();
    const found = secretsIn(record);
    if (found.length) {
      store.tx(() => {
        const version = raw.version();
        for (const { name, value } of found) {
          const r = system.migrate(name, value, 'sign-in');
          if (!r.ok) throw new Error(`sign-in: ${name} cannot be moved into the vault: ${r.error}`);
        }
        if (!raw.write(withoutSecrets(record), version)) throw new Error('the sign-in config changed while the daemon started: start it again');
      });
      o.logger.info(`hopper: ${found.length} sign-in realm secret(s) moved into the vault's system scope`);
    }
    const resealed = system.resealAll();
    if (resealed > 0) o.logger.info(`hopper: ${resealed} sign-in realm secret(s) sealed again under the current ${MASTER_KEY_VARIABLE}`);
    for (const c of system.check()) o.logger.warn(`hopper: start check: system secret ${c.name} ${c.problem}`);
  }
  return {
    instance: { ...store, signInConfig: sealedSignIn({ raw, system, tx: store.tx, logger: o.logger }) },
    system,
    connect(to) {
      sink = to;
      for (const e of waiting.splice(0)) to(e);
    },
  };
}
