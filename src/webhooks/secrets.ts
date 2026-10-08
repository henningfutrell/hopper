// A subscription's signing secret (issue #451, design.md "Secrets"): the hopper's own. It is kept in the
// user's store sealed (src/secrets/sealer.ts), bound to the subscription, and opened at each delivery, so a
// replaced or rotated secret signs from the next one. A subscription from before keeps reading the runtime
// variable it names (`secretEnv`, under the user's secret prefix) until a secret is stored for it. Nothing
// here logs, answers or appends the value; a secret that cannot be opened is said so, never read as none.
import { randomBytes } from 'node:crypto';
import type { UserStore } from '../domain/ports.ts';
import type { WebhookSubscription } from '../domain/types.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { SecretUnreadable, type SealerState } from '../secrets/sealer.ts';

/** Where a subscription's secret is kept: the context it is sealed for. The id, so a fold into another user keeps it. */
export const secretContext = (subscriptionId: string): string => `webhook:${subscriptionId}/signing-secret`;

/** A new signing secret: 32 random bytes, as 64 hex digits. */
export const makeSecret = (): string => randomBytes(32).toString('hex');

export interface WebhookSecrets {
  /** The secret a delivery to `sub` is signed with; throws with why there is none. */
  of(sub: WebhookSubscription): string;
  /** Why `sub` has no secret to sign with, or undefined. Never the secret. */
  problem(sub: WebhookSubscription): string | undefined;
  /** Why no secret can be stored now (no key), or undefined. */
  unavailable(): string | undefined;
  /** Seals `value` and keeps it as `id`'s secret; false when there is no key or no such subscription. */
  store(id: string, value: string): boolean;
  /** Seals again, under the current key, every secret an older key sealed. How many it sealed again. */
  resealAll(): number;
}

export function createWebhookSecrets(o: {
  store: Pick<UserStore, 'webhooks'>;
  keys: SealerState;
  /** The runtime's secrets, unprefixed: a subscription from before names its variable under `prefix`. */
  runtime: RuntimeSecrets;
  prefix: string;
  logger: { warn(line: string): void };
}): WebhookSecrets {
  const { webhooks } = o.store;
  const { sealer } = o.keys;

  function of(sub: WebhookSubscription): string {
    const sealed = webhooks.sealedSecret(sub.id);
    if (sealed !== undefined) {
      if (!sealer) throw new SecretUnreadable(`the stored secret cannot be opened: ${o.keys.problem}`);
      return sealer.open(sealed, secretContext(sub.id));
    }
    if (sub.secretEnv) {
      const name = `${o.prefix}${sub.secretEnv}`;
      const value = o.runtime(name);
      if (!value) throw new Error(`${name} is not set`);
      return value;
    }
    throw new Error('no signing secret is set: replace or rotate it');
  }

  return {
    of,
    problem(sub) {
      try { of(sub); return undefined; } catch (e) { return (e as Error).message; }
    },
    unavailable: () => (sealer ? undefined : `the hopper cannot store a secret: ${o.keys.problem}`),
    store(id, value) {
      if (!sealer) return false;
      return webhooks.setSecret(id, sealer.seal(value, secretContext(id))) !== undefined;
    },
    resealAll() {
      if (!sealer) return 0;
      let n = 0;
      for (const sub of webhooks.list()) {
        const sealed = webhooks.sealedSecret(sub.id);
        if (sealed === undefined || sealer.current(sealed)) continue;
        try {
          const value = sealer.open(sealed, secretContext(sub.id));
          webhooks.setSecret(sub.id, sealer.seal(value, secretContext(sub.id)), sub.secretChangedAt);
          n++;
        } catch (e) {
          o.logger.warn(`hopper: webhook "${sub.name}": ${(e as Error).message}`);
        }
      }
      return n;
    },
  };
}
