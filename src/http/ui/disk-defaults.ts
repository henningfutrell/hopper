// The disk defaults (issue #2494, design.md "Hopper's own disk use" → "Part 13"): an admin sets the disk thresholds and the
// sweep settings every machine takes where its own options are silent, or clears them. Read at each list of the machines,
// so they apply without a restart; GET /api/machines/disk-defaults reads them, and each machine of GET /api/machines shows
// them applied (`disk`, `sweep`), its own options in `diskThresholds` and `sweep` winning.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CAPPED_KINDS } from '../../domain/cache-caps.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const hours = z.number().min(0).optional();
const capGiB = z.number().min(0).max(100000).optional();

/** The disk defaults, each field as the machine option of the same meaning bounds it; null: none. */
export const diskDefaultsBody = z.strictObject({
  defaults: z.strictObject({
    diskLow: z.strictObject({
      belowGiB: z.number().positive().optional(), belowPercent: z.number().min(0).max(100).optional(),
      criticalBelowGiB: z.number().positive().optional(), criticalBelowPercent: z.number().min(0).max(100).optional(),
    }).optional(),
    sweep: z.strictObject({
      everyMinutes: z.number().int().min(1).optional(), scratchMaxAgeHours: z.number().positive().optional(),
      retainHours: z.strictObject({ finished: hours, failed: hours, cancelled: hours, rejected: hours }).optional(),
      pruneAfterDays: z.number().int().min(1).max(3650).optional(), trimAboveGiB: z.number().positive().max(100000).optional(),
      cacheCapsGiB: z.strictObject(Object.fromEntries(CAPPED_KINDS.map((k) => [k, capGiB])) as Record<(typeof CAPPED_KINDS)[number], typeof capGiB>).optional(),
      dryRun: z.boolean().optional(),
    }).optional(),
  }).nullable(),
});

/** The disk defaults' part of the API reference (src/http/openapi.ts). */
export const DISK_DEFAULTS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/machines/disk-defaults', tag: 'Machines and usage', summary: 'The disk defaults', description: 'Issue #2494. The disk thresholds (`diskLow`) and the sweep settings (`sweep`: the sweep interval, the retention per job status, the storage prune\'s age, the trim threshold, the cache caps and the dry run) every machine takes where its own options are silent; null: none.', returns: '`{ diskDefaults: DiskDefaults | null }`' },
  { method: 'post', path: '/ui/api/machines/disk-defaults', tag: 'Machines and usage', summary: 'Set the disk defaults', description: 'Issue #2494. Each field a machine\'s own options leave out takes the default here, a retention per status and a cache cap per kind each on its own; a container target takes none. They apply at the next list of the machines, with no restart: GET /api/machines shows each machine\'s `disk` judged by them and its `sweep` with them. `defaults: null` clears them.', role: 'admin', body: diskDefaultsBody, returns: '`{ diskDefaults: DiskDefaults | null }`' },
];

export function registerDiskDefaultsRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/machines/disk-defaults', async (req) => ({ diskDefaults: o.tenant(req).store.settings.getDiskDefaults() ?? null }));
  app.post('/ui/api/machines/disk-defaults', o.admin, async (req) => {
    const { defaults } = parseWith(diskDefaultsBody, req.body);
    o.tenant(req).store.settings.setDiskDefaults(defaults);
    return { diskDefaults: defaults };
  });
}
