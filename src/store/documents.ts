import { createHash } from 'node:crypto';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { StoreContext } from './context.ts';

/** sha-256 of a document's text, or `missing`. */
export const documentVersion = (text: string | undefined): string =>
  text === undefined ? 'missing' : createHash('sha256').update(text).digest('hex');

export function createConfigDocuments(c: StoreContext): ConfigDocuments {
  const read = (name: string): string | undefined => {
    const r = c.db.get('SELECT text FROM config_documents WHERE name = ?', name);
    return r ? String(r.text) : undefined;
  };
  return {
    read,
    version: (name) => documentVersion(read(name)),
    write(name, text, version) {
      return c.tx(() => {
        if (documentVersion(read(name)) !== version) return false;
        c.db.run(
          'INSERT INTO config_documents (name, text, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
          name, text, c.clock.now().toISOString(),
        );
        return true;
      });
    },
  };
}
