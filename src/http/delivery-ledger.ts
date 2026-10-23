// The delivery ledger's read (issue #2554 part 6, design.md "Delivery forecasts"): GET /api/delivery-ledger, the rows the
// ledger pass kept — for each step of a change, its first prediction and its actual times — and the forecast accuracy
// computed from them, of one job, of one repository, or of all. Read only.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forecastAccuracy, type AccuracyReport, type DeliveryLedgerRow } from '../domain/forecast-accuracy.ts';
import { DELIVERY_LEDGER_EVERY_MS } from '../engine/delivery-ledger.ts';
import { parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

export const deliveryLedgerQuery = z.strictObject({
  job: z.string().min(1).max(200).optional(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
}).refine((q) => q.job === undefined || q.repo === undefined, { message: 'name a job or a repo, not both' });

export interface DeliveryLedgerView { rows: DeliveryLedgerRow[]; accuracy: AccuracyReport }

export const DELIVERY_LEDGER_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/delivery-ledger', tag: 'Jobs', summary: 'The delivery ledger: each step of each change, predicted and actual, and the forecast accuracy', description: `The delivery ledger (issue #2554 part 6). Every ${DELIVERY_LEDGER_EVERY_MS / 60_000} minutes the ledger pass forecasts each change of the last 30 days as \`GET /api/delivery-forecast\` does, and keeps one row per change (\`key\` \`job:<id>\`) and delivery step: \`predictedStart\` and \`predictedEnd\` (p50) of the first forecast that gave the step a time, made at \`predictedAt\` — a later forecast never replaces it —, and \`actualStart\` and \`actualEnd\` once the step started and ended (the measured steps from the job's events, the scheduled steps from its promotion set schedule and gate clearances). A change delivered before its first pass has actual times only. \`accuracy\`: the mean absolute error in ms of the predicted ends, per step (\`byStep\`) and per repository and step (\`byRepo\`), with the sample size; a row with no predicted or no actual end is not counted. Filters: \`job\` (a job id) or \`repo\` (\`owner/name\`), not both; none: every row. 400: a bad query.`, query: deliveryLedgerQuery, returns: '`DeliveryLedgerView` `{ rows: DeliveryLedgerRow[], accuracy: { byStep, byRepo } }`', errors: [400] },
];

export function deliveryLedgerRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/delivery-ledger', async (req): Promise<DeliveryLedgerView> => {
    const q = parseWith(deliveryLedgerQuery, req.query);
    const rows = o.tenant(req).store.deliveryLedger.list(q.job !== undefined ? { key: `job:${q.job}` } : q.repo !== undefined ? { repo: q.repo } : {});
    return { rows, accuracy: forecastAccuracy(rows) };
  });
}
