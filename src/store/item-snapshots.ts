// The item snapshots (issue #662): one row per source item key, the snapshot as JSON. A new snapshot replaces the one
// before; the events keep each hash.
import type { ItemSnapshotRepository } from '../domain/ports.ts';
import type { ItemSnapshot } from '../domain/item-snapshots.ts';
import { parse, type StoreContext } from './context.ts';

export function createItemSnapshotRepository(c: StoreContext): ItemSnapshotRepository {
  return {
    get(key) {
      const r = c.db.get('SELECT body FROM item_snapshots WHERE key = ?', key);
      return r ? parse<ItemSnapshot>(r.body) : undefined;
    },
    put(snapshot) {
      c.db.run('INSERT INTO item_snapshots (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body', snapshot.key, JSON.stringify(snapshot));
      return snapshot;
    },
  };
}
