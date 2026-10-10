// A subscription's signing secret (issues #451, #658, design.md "Secrets"): the hopper's own. It is a system secret in the
// user's vault (`webhook.<id>.signing-secret`, src/vault/system.ts), sealed, and opened at each delivery, so a replaced
// or rotated secret signs from the next one. A subscription from before #451 keeps reading the runtime variable it
// names (`secretEnv`, under the user's secret prefix) until a secret is stored for it. Nothing here logs, answers or
// appends the value; a secret that cannot be opened is said so, never read as none.
import { randomBytes } from 'node:crypto';
import type { UserStore } from '../domain/ports.ts';
import type { WebhookSubscription } from '../domain/types.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { SystemSecrets } from '../vault/system.ts';

/** Where a subscription's secret was sealed before issue #658, in its row: the context it was sealed for. */
export const secretContext = (subscriptionId: string): string => `webhook:${subscriptionId}/signing-secret`;
/** The system secret a subscription's signing secret is kept as (issue #658). */
export const signingSecretName = (subscriptionId: string): SystemSecretName => `webhook.${subscriptionId}.signing-secret`;

/** A new signing secret: 32 random bytes, as 64 hex digits. */
export const makeSecret = (): string => randomBytes(32).toString('hex');

export interface WebhookSecrets {
  /** The secret a delivery to `sub` is signed with; throws with why there is none. */
  of(sub: WebhookSubscription): string;
  /** Why `sub` has no secret to sign with, or undefined. Never the secret. */
  problem(sub: WebhookSubscription): string | undefined;
  /** Why no secret can be stored now (no key), or undefined. */
  unavailable(): string | undefined;
  /** Keeps `value` as `id`'s secret in the vault; `rotated`: the hopper made it in place of one. False when there is no key or no such subscription. */
  store(id: string, value: string, by: string, rotated?: boolean): boolean;
  /** The subscription's secret goes with it. */
  forget(id: string, by: string): void;
}

export function createWebhookSecrets(o: {
  store: Pick<UserStore, 'webhooks' | 'tx'>;
  system: SystemSecrets;
  /** The runtime's secrets, unprefixed: a subscription from before names its variable under `prefix`. */
  runtime: RuntimeSecrets;
  prefix: string;
}): WebhookSecrets {
  const { webhooks } = o.store;

  function of(sub: WebhookSubscription): string {
    let kept: string | undefined;
    try {
      kept = o.system.open(signingSecretName(sub.id), 'webhook');
    } catch (e) {
      if (e instanceof SecretUnreadable) throw new SecretUnreadable(`the stored secret cannot be opened: ${o.system.problem() ?? e.message}`);
      throw e;
    }
    if (kept !== undefined) return kept;
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
    unavailable: () => o.system.problem(),
    store(id, value, by, rotated = false) {
      if (o.system.problem()) return false;
      return o.store.tx(() => {
        if (!webhooks.get(id)) return false;
        if (!o.system.keep(signingSecretName(id), value, by, rotated ? { rotated } : {}).ok) return false;
        return webhooks.secretKept(id) !== undefined;
      });
    },
    forget(id, by) {
      o.system.drop(signingSecretName(id), by);
    },
  };
}
