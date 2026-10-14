// The memory alert (issue #868, design.md "Machine resources over time" → "WSL and the memory alert"): an admin sets the
// free memory under which, for how many minutes, a person is told (`machine.memory_low`), or turns it off. Read at every
// record of the machine samples, so it applies without a restart; GET /api/machines/history carries it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MAX_MEMORY_ALERT_MINUTES } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The memory alert: the free memory under which, for how many minutes, a person is told; null: off. */
export const memoryAlertBody = z.strictObject({
  alert: z.strictObject({
    freeBytes: z.number().int().positive('a threshold above 0'),
    minutes: z.number().int().min(0).max(MAX_MEMORY_ALERT_MINUTES),
  }).nullable(),
});

/** The memory alert's part of the API reference (src/http/openapi.ts). */
export const MEMORY_ALERT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/memory-alert', tag: 'Machines and usage', summary: 'Set the memory alert', description: 'Issue #868. A machine whose free memory stays under `alert.freeBytes` for `alert.minutes` (0: at the first reading under) is told as `machine.memory_low`, and as `machine.memory_recovered` once it is back over; webhooks and notifiers take them. The free memory is Windows\' own for a WSL machine that reads it, else memory available; a container and a WSL machine with no Windows reading are not watched. `alert: null` turns it off. GET /api/machines/history carries it.', role: 'admin', body: memoryAlertBody, returns: '`{ memoryAlert: MemoryAlert | null }`' },
];

export function registerMemoryAlertRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/machines/memory-alert', o.admin, async (req) => {
    const { alert } = parseWith(memoryAlertBody, req.body);
    o.tenant(req).store.settings.setMemoryAlert(alert);
    return { memoryAlert: alert };
  });
}
