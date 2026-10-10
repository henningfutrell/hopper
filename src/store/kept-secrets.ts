// What the users' schemas keep sealed under the master key (issue #659, design.md "The master key"), read at start
// before any runtime: the key ids of the sealed values (the webhook signing secrets and the vault secrets,
// src/secrets/sealer.ts) and the connected accounts' sealed tokens (src/secrets/token-box.ts). It tells a fresh
// hopper from one whose key is missing, and a key that sealed them from one that did not. A vault a KMS data key
// seals (issue #586) is left out: the master key does not seal its values. A table a schema lacks yet is skipped.
import type { KeptSecrets } from '../domain/store.ts';
import type { Db } from './db.ts';
import { quoteIdent } from './tenant-migrations.ts';

/** The data key the KMS wrapped, a row of a user's config table (src/store/vault.ts). */
const DATA_KEY = 'vault-data-key';
const TOKEN = /sealed:v1:[A-Za-z0-9_-]+/g;

export function keptSecrets(db: Db, schemas: readonly string[]): KeptSecrets {
  const keyIds = new Set<string>();
  const tokens: string[] = [];
  const has = (schema: string, table: string, column?: string): boolean => column === undefined
    ? db.get('SELECT to_regclass(?::text) AS t', `${quoteIdent(schema)}.${table}`)!.t !== null
    : db.get('SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?', schema, table, column) !== undefined;
  const idsOf = (rows: Record<string, unknown>[]): void => {
    for (const r of rows) {
      const parts = String(r.sealed).split('.');
      if (parts[0] === 'hs1' && parts[1]) keyIds.add(parts[1]);
    }
  };
  for (const schema of schemas) {
    const s = quoteIdent(schema);
    if (has(schema, 'webhooks', 'secret_sealed')) idsOf(db.all(`SELECT secret_sealed AS sealed FROM ${s}.webhooks WHERE secret_sealed IS NOT NULL`));
    const kms = has(schema, 'config') && db.get(`SELECT 1 FROM ${s}.config WHERE name = ?`, DATA_KEY) !== undefined;
    if (!kms && has(schema, 'vault_secrets')) idsOf(db.all(`SELECT sealed FROM ${s}.vault_secrets WHERE sealed IS NOT NULL`));
    if (has(schema, 'connected_accounts')) {
      for (const r of db.all(`SELECT body FROM ${s}.connected_accounts WHERE body LIKE '%sealed:v1:%'`)) tokens.push(...String(r.body).match(TOKEN) ?? []);
    }
  }
  return { keyIds: [...keyIds], tokens };
}
