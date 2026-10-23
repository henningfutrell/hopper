// The delivery ledger pass (issue #2554 part 6, design.md "Delivery forecasts"): every DELIVERY_LEDGER_EVERY_MS, on the host
// that holds its lease, each change of the last HISTORY_DAYS days is forecast as GET /api/delivery-forecast does, and the
// delivery ledger keeps, for each step, the first prediction that gave it a time and the actual start and end it has now:
// the measured steps from the change's events, the scheduled steps from its promotion set schedule and gate clearances.
import { scheduledActuals } from '../domain/delivery-forecast.ts';
import { DEFAULT_DELIVERY_SETTINGS, deliveryOf } from '../domain/delivery-settings.ts';
import { deliveryLedger, type DeliveryLedgerRow } from '../domain/forecast-accuracy.ts';
import type { UserStore } from '../domain/store.ts';
import { carriesNoChange, clearancesOf, clearedOf, forecastOf, historyOf, tracksOf } from './delivery-reads.ts';

export const DELIVERY_LEDGER_EVERY_MS = 10 * 60_000;

/** One pass at `now`: the ledger rows of every change of the window, kept in one transaction; answers how many it wrote. */
export function recordDeliveryLedger(store: UserStore, now: Date): number {
  const at = now.toISOString();
  const { tracks, windowStart } = tracksOf({ store }, now);
  const settings = store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS;
  const clearances = clearancesOf({ store });
  const histories = new Map<string, ReturnType<typeof historyOf>>();
  const rows: DeliveryLedgerRow[] = [];
  for (const track of tracks.values()) {
    if (!track.repo || carriesNoChange({ store }, track)) continue;
    const repo = track.repo.toLowerCase();
    const d = deliveryOf(settings, repo);
    if (!histories.has(repo)) histories.set(repo, historyOf(tracks, windowStart, repo));
    const cleared = clearedOf(clearances, d, repo, track.current);
    const f = forecastOf(track, d, histories.get(repo)!, at, cleared);
    const measured = track.actuals;
    const scheduled = track.current.step === 'promotion_set' ? scheduledActuals(d.schedule, track.current, d.gates, at, cleared) : [];
    rows.push(...deliveryLedger(repo, `job:${track.jobId}`, 'forecast' in f ? f.forecast.normal : { steps: [] }, [...measured, ...scheduled]));
  }
  return store.deliveryLedger.record(rows, at);
}
