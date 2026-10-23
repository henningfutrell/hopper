// The delivery ledger kept (issue #2554 part 6, tenant migration 99, design.md "Delivery forecasts"): one row per change and
// delivery step. The ledger pass writes it: the first prediction that gave the step a time stays, so the accuracy measures
// what was told; the actual start and end are written as the step starts and ends.
import { DELIVERY_STEPS, type DeliveryStep } from '../domain/delivery-steps.ts';
import type { DeliveryLedgerRepository, DeliveryLedgerRow } from '../domain/forecast-accuracy.ts';
import type { StoreContext } from './context.ts';

export const DELIVERY_LEDGER_TABLE = `CREATE TABLE IF NOT EXISTS delivery_ledger (key TEXT NOT NULL, step TEXT NOT NULL, repo TEXT NOT NULL,
  predicted_start TEXT, predicted_end TEXT, predicted_at TEXT, actual_start TEXT, actual_end TEXT, PRIMARY KEY (key, step));
  CREATE INDEX IF NOT EXISTS delivery_ledger_repo ON delivery_ledger (repo)`;

const order = (s: string): number => DELIVERY_STEPS.indexOf(s as DeliveryStep);

function rowOf(r: Record<string, unknown>): DeliveryLedgerRow {
  const out: DeliveryLedgerRow = { repo: String(r.repo), key: String(r.key), step: String(r.step) as DeliveryStep };
  for (const [col, k] of [['predicted_start', 'predictedStart'], ['predicted_end', 'predictedEnd'], ['actual_start', 'actualStart'], ['actual_end', 'actualEnd'], ['predicted_at', 'predictedAt']] as const) {
    if (r[col] !== null && r[col] !== undefined) out[k] = String(r[col]);
  }
  return out;
}

export function createDeliveryLedgerRepository(c: StoreContext): DeliveryLedgerRepository {
  return {
    record(rows, at) {
      c.tx(() => {
        for (const r of rows) {
          const predicted = r.predictedEnd !== undefined;
          c.db.run(`INSERT INTO delivery_ledger (key, step, repo, predicted_start, predicted_end, predicted_at, actual_start, actual_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (key, step) DO UPDATE SET
              predicted_start = CASE WHEN delivery_ledger.predicted_end IS NULL THEN excluded.predicted_start ELSE delivery_ledger.predicted_start END,
              predicted_at = CASE WHEN delivery_ledger.predicted_end IS NULL THEN excluded.predicted_at ELSE delivery_ledger.predicted_at END,
              predicted_end = COALESCE(delivery_ledger.predicted_end, excluded.predicted_end),
              actual_start = COALESCE(excluded.actual_start, delivery_ledger.actual_start),
              actual_end = COALESCE(excluded.actual_end, delivery_ledger.actual_end)`,
          r.key, r.step, r.repo.toLowerCase(), predicted ? r.predictedStart ?? null : null, predicted ? r.predictedEnd! : null, predicted ? at : null, r.actualStart ?? null, r.actualEnd ?? null);
        }
      });
    },
    list(q = {}) {
      const rows = q.key !== undefined ? c.db.all('SELECT * FROM delivery_ledger WHERE key = ?', q.key)
        : q.repo !== undefined ? c.db.all('SELECT * FROM delivery_ledger WHERE repo = ?', q.repo.toLowerCase())
          : c.db.all('SELECT * FROM delivery_ledger');
      return rows.map(rowOf).sort((a, b) => a.key.localeCompare(b.key) || order(a.step) - order(b.step));
    },
  };
}
