import { createHash } from 'node:crypto';
import type { ConfigRecords } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

/** sha-256 of a record's JSON, or `missing`. */
const versionOf = (json: string | undefined): string =>
  json === undefined ? 'missing' : createHash('sha256').update(json).digest('hex');

/** The config records `names` in the context's schema: a user's (plugins, rules) or the instance's (sign-in); any other name throws. */
export function createConfigRecords<N extends string>(c: StoreContext, names: readonly N[]): ConfigRecords<N> {
  const json = (name: N): string | undefined => {
    if (!names.includes(name)) throw new Error(`no config record ${name} here; one of ${names.join(', ')}`);
    const r = c.db.get('SELECT value FROM config WHERE name = ?', name);
    return r ? String(r.value) : undefined;
  };
  return {
    read(name) {
      const v = json(name);
      return v === undefined ? undefined : JSON.parse(v) as unknown;
    },
    version: (name) => versionOf(json(name)),
    // Compare-and-swap, so it holds across processes (READ COMMITTED takes no lock on the read): a new
    // record is inserted only if none is there, an existing one replaced only while it still holds the
    // JSON read.
    write(name, value, version) {
      const current = json(name);
      if (versionOf(current) !== version) return false;
      const next = JSON.stringify(value);
      const at = c.clock.now().toISOString();
      return current === undefined
        ? c.db.run('INSERT INTO config (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING', name, next, at).changes > 0
        : c.db.run('UPDATE config SET value = ?, updated_at = ? WHERE name = ? AND value = ?', next, at, name, current).changes > 0;
    },
  };
}
