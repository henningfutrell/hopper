// One user's part of the vault's system scope at start (issue #658, design.md "The vault's system scope"): the system
// secrets service every part that keeps a secret of the hopper's own writes through — the GitHub connection's tokens,
// the webhook signing secrets, the TypeSafe API key —; each one an older key sealed sealed again; the secrets kept before
// #658 in their own rows moved into it once; and the start check. The move reads each old copy, keeps it in the vault,
// opens it again, and only then removes the old copy: one `vault.secret_migrated` event per secret, never a value. A start
// that finds nothing left to move changes nothing. An old copy that cannot be opened (its key is missing) stays where it
// is, and the start check names the key.
import { randomUUID } from 'node:crypto';
import type { Clock, UserStore } from '../domain/ports.ts';
import { CONNECTED_ACCOUNT_PROVIDERS, type User, type VaultAccess } from '../domain/types.ts';
import { accessTokenName, PROVIDER_NAME, refreshTokenName } from '../connected-accounts/at-rest.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { sealerOf, type SealerState } from '../secrets/sealer.ts';
import { createTokenBox, isSealed, PREVIOUS_KEYS_VARIABLE, MASTER_KEY_VARIABLE, type TokenBox } from '../secrets/token-box.ts';
import { createSystemSecrets, type SystemSecrets } from '../vault/system.ts';
import { secretContext, signingSecretName } from '../webhooks/index.ts';

interface Logger { info(line: string): void; warn(line: string): void }

/** The token box under the runtime's keys: what sealed a connected account's tokens before issue #658. */
function legacyBox(env: Record<string, string | undefined>): TokenBox | undefined {
  const secret = runtimeSecrets(env);
  const key = secret(MASTER_KEY_VARIABLE);
  return key ? createTokenBox(key, (secret(PREVIOUS_KEYS_VARIABLE) ?? '').split(/[\s,]+/).filter(Boolean)) : undefined;
}

/** Moves each webhook signing secret kept in its subscription's row into the vault. How many moved. */
export function moveWebhookSecrets(o: { store: Pick<UserStore, 'webhooks' | 'tx'>; system: SystemSecrets; keys: SealerState; logger: Logger }): number {
  let n = 0;
  for (const sub of o.store.webhooks.list()) {
    const old = o.store.webhooks.legacySecret(sub.id);
    if (old === undefined) continue;
    const name = signingSecretName(sub.id);
    if (o.system.stored(name) !== undefined) { o.store.webhooks.secretKept(sub.id, sub.secretChangedAt); continue; }
    let value: string;
    try {
      if (!o.keys.sealer) throw new Error(o.keys.problem);
      value = o.keys.sealer.open(old, secretContext(sub.id));
    } catch (e) {
      o.logger.warn(`hopper: webhook "${sub.name}": its signing secret stays where it was, not moved into the vault: ${(e as Error).message}`);
      continue;
    }
    const moved = o.store.tx(() => {
      const r = o.system.migrate(name, value, 'webhooks');
      if (r.ok) o.store.webhooks.secretKept(sub.id, sub.secretChangedAt);
      return r;
    });
    if (moved.ok) n++;
    else o.logger.warn(`hopper: webhook "${sub.name}": its signing secret stays where it was: ${moved.error}`);
  }
  return n;
}

/** Moves each connected account's tokens kept in its row into the vault, under the account's renewal lock. How many moved. */
export function moveConnectedAccountTokens(o: { store: Pick<UserStore, 'connectedAccounts' | 'tx'>; system: SystemSecrets; box: TokenBox | undefined; logger: Logger }): number {
  let n = 0;
  const accounts = o.store.connectedAccounts;
  for (const provider of CONNECTED_ACCOUNT_PROVIDERS) {
    const old = accounts.legacyTokens(provider);
    if (!old) continue;
    if (!accounts.lock(provider)) { o.logger.warn(`hopper: ${PROVIDER_NAME[provider]}: another process holds the connection; its tokens are moved into the vault at the next start`); continue; }
    try {
      const open = (t: string): string => {
        if (!isSealed(t)) return t;
        if (!o.box) throw new Error(`the master key is missing: give it as ${MASTER_KEY_VARIABLE} at launch`);
        return o.box.open(t);
      };
      let tokens: { accessToken: string; refreshToken?: string };
      try {
        tokens = { accessToken: open(old.accessToken), ...(old.refreshToken !== undefined ? { refreshToken: open(old.refreshToken) } : {}) };
      } catch (e) {
        o.logger.warn(`hopper: ${PROVIDER_NAME[provider]}: the connection's tokens stay where they were, not moved into the vault: ${(e as Error).message}`);
        continue;
      }
      n += o.store.tx(() => {
        // A connection kept in the vault already (made since) is newer than the old copy: only the old copy goes.
        let kept = 0;
        if (o.system.stored(accessTokenName(provider)) === undefined) {
          for (const [name, value] of [[accessTokenName(provider), tokens.accessToken], [refreshTokenName(provider), tokens.refreshToken]] as const) {
            if (value === undefined) continue;
            const r = o.system.migrate(name, value, 'connected_accounts');
            if (!r.ok) throw new Error(r.error);
            kept++;
          }
        }
        accounts.dropLegacyTokens(provider);
        return kept;
      });
    } catch (e) {
      o.logger.warn(`hopper: ${PROVIDER_NAME[provider]}: the connection's tokens stay where they were: ${(e as Error).message}`);
    } finally {
      accounts.unlock(provider);
    }
  }
  return n;
}

/** The user's system secrets at start: sealed again where an older key sealed them, the old copies moved in, checked. */
export function openUserSystemSecrets(o: {
  user: User; store: UserStore; env: Record<string, string | undefined>; access?: VaultAccess; clock: Clock; logger: Logger;
}): { system: SystemSecrets; keys: SealerState } {
  const keys = sealerOf(runtimeSecrets(o.env));
  if (keys.problem) o.logger.warn(`hopper: ${keys.problem}: the hopper's own secrets in the vault are neither opened nor kept, and none kept before is moved there`);
  const system = createSystemSecrets({ store: o.store, keys, userId: o.user.id, ...(o.access ? { access: o.access } : {}), clock: o.clock, idGen: randomUUID, logger: o.logger });
  const moved = moveWebhookSecrets({ store: o.store, system, keys, logger: o.logger })
    + moveConnectedAccountTokens({ store: o.store, system, box: legacyBox(o.env), logger: o.logger });
  if (moved > 0) o.logger.info(`hopper: ${moved} of the hopper's own secret(s) moved into the vault's system scope`);
  const resealed = system.resealAll();
  if (resealed > 0) o.logger.info(`hopper: ${resealed} system secret(s) sealed again under the current ${MASTER_KEY_VARIABLE}`);
  for (const c of system.check()) o.logger.warn(`hopper: start check: system secret ${c.name} ${c.problem}`);
  return { system, keys };
}
