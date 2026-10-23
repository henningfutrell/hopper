// Each machine's last disk measure (issue #2494, tenant migration 94): one row per machine, the measure as JSON. The sweep
// writes it after each pass's survey and reads it back once, when it starts, so a restart still shows it.
import type { DiskMeasure, DiskMeasureRepository } from '../domain/hopper-disk.ts';
import type { StoreContext } from './context.ts';

export const DISK_MEASURE_TABLE = 'CREATE TABLE IF NOT EXISTS machine_disk_measures (machine_id TEXT PRIMARY KEY, at TEXT NOT NULL, measure TEXT NOT NULL)';

export function createDiskMeasureRepository(c: StoreContext): DiskMeasureRepository {
  return {
    keep(machineId, m) {
      c.db.run(`INSERT INTO machine_disk_measures (machine_id, at, measure) VALUES (?, ?, ?)
        ON CONFLICT (machine_id) DO UPDATE SET at = excluded.at, measure = excluded.measure`, machineId, m.at, JSON.stringify(m));
    },
    all() {
      return c.db.all('SELECT machine_id, measure FROM machine_disk_measures ORDER BY machine_id')
        .map((r) => [String(r.machine_id), JSON.parse(String(r.measure)) as DiskMeasure]);
    },
  };
}
