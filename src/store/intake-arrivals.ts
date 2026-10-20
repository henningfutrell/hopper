// Each item's arrival in a source's intake (issue #2228, tenant migration 87): one row per source and item key, the time
// the source first listed it. A row is never changed or removed, so no sync and no restart moves an arrival.
import type { IntakeArrivalRepository } from '../domain/intake.ts';
import type { StoreContext } from './context.ts';

export const INTAKE_ARRIVAL_TABLE = 'CREATE TABLE IF NOT EXISTS intake_arrivals (source TEXT NOT NULL, key TEXT NOT NULL, arrived_at TEXT NOT NULL, PRIMARY KEY (source, key))';

export function createIntakeArrivalRepository(c: StoreContext): IntakeArrivalRepository {
  const read = (source: string) => new Map(c.db.all('SELECT key, arrived_at FROM intake_arrivals WHERE source = ?', source).map((r) => [String(r.key), String(r.arrived_at)]));
  return {
    arrive(source, keys, at) {
      const kept = read(source);
      const fresh = keys.filter((k) => !kept.has(k));
      if (fresh.length === 0) return kept;
      // Another hopper on this store may list the same item at the same time: the first row stays, and is read back.
      c.tx(() => { for (const key of fresh) c.db.run('INSERT INTO intake_arrivals (source, key, arrived_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', source, key, at); });
      return read(source);
    },
  };
}
