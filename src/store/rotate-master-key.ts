// The master key rotation's writes (issue #659 requirement 6, design.md "Rotating the master key"): every value the old
// keys sealed, in the instance's schema and every user's, opened and sealed again under the new key, bound to the same
// place, with the new fingerprint and the rotation recorded — one transaction on the instance's connection, so a failed
// write leaves every row and the fingerprint as they were. The values: each vault's rows (`vault_secrets`: the vault
// secrets, the system and the shared secrets), and the copies from before issue #658 a start could not move yet (a
// webhook's `secret_sealed`, a connected account's sealed tokens). A row no old key sealed — a KMS data key's (issue
// #586), or one under a key long gone — is not the master key's to rotate, and is left. A row an old key sealed that does
// not open is counted and left: it did not open before either.
import type { MasterKeyResealed } from '../domain/store.ts';
import { createSealer } from '../secrets/sealer.ts';
import { createTokenBox } from '../secrets/token-box.ts';
import { vaultContext } from '../vault/reseal.ts';
import { secretContext } from '../webhooks/secrets.ts';
import type { Db } from './db.ts';
import { quoteIdent } from './tenant-migrations.ts';

const TOKEN = /sealed:v1:[A-Za-z0-9_-]+/g;

export function resealUnderNewKey(db: Db, schemas: readonly string[], o: { from: { key: string; previous: readonly string[] }; to: string }): MasterKeyResealed {
  const old = createSealer(o.from.key, o.from.previous);
  const oldIds = new Set([o.from.key, ...o.from.previous].map((k) => createSealer(k).keyId));
  const next = createSealer(o.to);
  const oldBox = createTokenBox(o.from.key, o.from.previous);
  const nextBox = createTokenBox(o.to);
  const done: MasterKeyResealed = { resealed: 0, unreadable: 0 };
  const has = (schema: string, table: string, column: string): boolean =>
    db.get('SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?', schema, table, column) !== undefined;
  /** `sealed` under the new key, or undefined: no old key sealed it, or it does not open. */
  const again = (sealed: string, context: string): string | undefined => {
    if (!oldIds.has(sealed.split('.')[1] ?? '')) return undefined;
    let value: string;
    try {
      value = old.open(sealed, context);
    } catch {
      done.unreadable++;
      return undefined;
    }
    done.resealed++;
    return next.seal(value, context);
  };

  for (const schema of schemas) {
    const s = quoteIdent(schema);
    if (has(schema, 'vault_secrets', 'sealed')) {
      for (const r of db.all(`SELECT id, sealed FROM ${s}.vault_secrets WHERE sealed IS NOT NULL ORDER BY seq`)) {
        const sealed = again(String(r.sealed), vaultContext(String(r.id)));
        if (sealed !== undefined) db.run(`UPDATE ${s}.vault_secrets SET sealed = ? WHERE id = ?`, sealed, String(r.id));
      }
    }
    if (has(schema, 'webhooks', 'secret_sealed')) {
      for (const r of db.all(`SELECT id, secret_sealed FROM ${s}.webhooks WHERE secret_sealed IS NOT NULL ORDER BY seq`)) {
        const sealed = again(String(r.secret_sealed), secretContext(String(r.id)));
        if (sealed !== undefined) db.run(`UPDATE ${s}.webhooks SET secret_sealed = ? WHERE id = ?`, sealed, String(r.id));
      }
    }
    if (has(schema, 'connected_accounts', 'body')) {
      for (const r of db.all(`SELECT provider, body FROM ${s}.connected_accounts WHERE body LIKE '%sealed:v1:%' ORDER BY provider`)) {
        let changed = false;
        const body = String(r.body).replace(TOKEN, (token) => {
          let value: string;
          try {
            value = oldBox.open(token);
          } catch {
            done.unreadable++;
            return token;
          }
          done.resealed++;
          changed = true;
          return nextBox.seal(value);
        });
        if (changed) db.run(`UPDATE ${s}.connected_accounts SET body = ? WHERE provider = ?`, body, String(r.provider));
      }
    }
  }
  return done;
}
