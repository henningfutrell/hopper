// Forecast accuracy (issue #2554, design.md "Delivery forecasts"): the **delivery ledger** of a change — for each step,
// its predicted start and end (from a forecast) and its actual ones — and the mean absolute error of the predicted ends,
// per step and per repository, so the forecast can be measured and tuned. Pure.
import { DELIVERY_STEPS, type DeliveryStep } from './delivery-steps.ts';
import type { DeliveryPath } from './delivery-forecast.ts';

/** When a step of a change actually started and ended. */
export interface StepActual { step: DeliveryStep; start: string; end?: string }

export interface DeliveryLedgerRow {
  repo: string;
  /** The change: `job:<id>`, `issue:<owner/name#n>`, `pr:<owner/name#n>` or `set:<owner/name#n>`. */
  key: string;
  step: DeliveryStep;
  predictedStart?: string;
  predictedEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  /** When the prediction kept was made (issue #2554 part 6): the first forecast that gave the step a time. */
  predictedAt?: string;
}

/** The delivery ledger kept (issue #2554 part 6, tenant migration 99): a step's first prediction stays, its actual times are the newest. */
export interface DeliveryLedgerRepository {
  /** Keeps each row: its prediction only when the step has none yet (made at `at`), its actual times when it has them. */
  record(rows: readonly DeliveryLedgerRow[], at: string): void;
  /** The rows of one change (`key`) or of one repository, else every row; by change, then step order. */
  list(q?: { key?: string; repo?: string }): DeliveryLedgerRow[];
}

export interface AccuracyReport {
  byStep: { step: DeliveryStep; samples: number; meanAbsErrorMs: number }[];
  byRepo: { repo: string; step: DeliveryStep; samples: number; meanAbsErrorMs: number }[];
}

/** One row per step a prediction or an actual names, in step order. */
export function deliveryLedger(repo: string, key: string, predicted: DeliveryPath, actuals: readonly StepActual[]): DeliveryLedgerRow[] {
  return DELIVERY_STEPS.flatMap((step) => {
    const p = predicted.steps.find((s) => s.step === step);
    const a = actuals.find((s) => s.step === step);
    if (!p && !a) return [];
    const row: DeliveryLedgerRow = { repo, key, step };
    if (p?.start) row.predictedStart = p.start;
    if (p?.end) row.predictedEnd = p.end;
    if (a) row.actualStart = a.start;
    if (a?.end) row.actualEnd = a.end;
    return [row];
  });
}

/** The mean absolute error of the predicted ends; a row with no predicted or no actual end is not counted. */
export function forecastAccuracy(rows: readonly DeliveryLedgerRow[]): AccuracyReport {
  const sums = new Map<string, { repo?: string; step: DeliveryStep; samples: number; total: number }>();
  const add = (k: string, repo: string | undefined, step: DeliveryStep, err: number) => {
    const s = sums.get(k) ?? { ...(repo === undefined ? {} : { repo }), step, samples: 0, total: 0 };
    s.samples++;
    s.total += err;
    sums.set(k, s);
  };
  for (const r of rows) {
    if (!r.predictedEnd || !r.actualEnd) continue;
    const err = Math.abs(Date.parse(r.actualEnd) - Date.parse(r.predictedEnd));
    add(`step\u0000${r.step}`, undefined, r.step, err);
    add(`repo\u0000${r.repo}\u0000${r.step}`, r.repo, r.step, err);
  }
  const order = (s: DeliveryStep) => DELIVERY_STEPS.indexOf(s);
  const all = [...sums.values()].map((s) => ({ ...s, meanAbsErrorMs: s.total / s.samples }));
  return {
    byStep: all.filter((s) => s.repo === undefined).sort((a, b) => order(a.step) - order(b.step))
      .map(({ step, samples, meanAbsErrorMs }) => ({ step, samples, meanAbsErrorMs })),
    byRepo: all.filter((s) => s.repo !== undefined)
      .sort((a, b) => a.repo!.localeCompare(b.repo!) || order(a.step) - order(b.step))
      .map(({ repo, step, samples, meanAbsErrorMs }) => ({ repo: repo!, step, samples, meanAbsErrorMs })),
  };
}
