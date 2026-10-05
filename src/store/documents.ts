import { createHash } from 'node:crypto';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

/** sha-256 of a document's text, or `missing`. */
export const documentVersion = (text: string | undefined): string =>
  text === undefined ? 'missing' : createHash('sha256').update(text).digest('hex');

/** The documents `names` in the context's schema: a user's (plugins.yaml, rules.md) or the instance's (auth.yaml); any other name throws. */
export function createConfigDocuments<N extends string>(c: StoreContext, names: readonly N[]): ConfigDocuments<N> {
  const read = (name: N): string | undefined => {
    if (!names.includes(name)) throw new Error(`no config document ${name} here; one of ${names.join(', ')}`);
    const r = c.db.get('SELECT text FROM config_documents WHERE name = ?', name);
    return r ? String(r.text) : undefined;
  };
  return {
    read,
    version: (name) => documentVersion(read(name)),
    // Compare-and-swap, so it holds across processes on Postgres too (READ COMMITTED takes no lock
    // on the read): a new document is inserted only if none is there, an existing one replaced only
    // while it still holds the text read.
    write(name, text, version) {
      const current = read(name);
      if (documentVersion(current) !== version) return false;
      const at = c.clock.now().toISOString();
      return current === undefined
        ? c.db.run('INSERT INTO config_documents (name, text, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO NOTHING', name, text, at).changes > 0
        : c.db.run('UPDATE config_documents SET text = ?, updated_at = ? WHERE name = ? AND text = ?', text, at, name, current).changes > 0;
    },
  };
}
