// Add machine's route. Issue #308: a one-time join code, for the session's user: the line the machine runs carries it
// (design.md "Joining a machine"); only the code's hash is written, the machine's join adds it. A sandbox never joins as a
// machine (issue #1349): a job's step runs in a sandbox of its own, burned after it.
// Pod / Kubernetes (issue #1454): the session's user's lane pool key, issued or revoked with no restart, for lane pods of a
// chart release that is not this hopper's own (design.md "Lane pods of another release"). Only its hash is kept.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, InstanceStore } from '../../domain/ports.ts';
import { mintJoinCode } from '../../machines/join-code.ts';
import { issueLanePoolKey } from '../../machines/lane-pool.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';
import { joinTemplate } from './vault.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** `template`: the template the machine joins as (issue #558). */
export const machineJoinBody = z.strictObject({ template: z.string().min(1).max(64).optional() });

/** `issue`: a new lane pool key, in place of the one the user had; `revoke`: none any more. */
export const lanePoolKeyBody = z.strictObject({ action: z.enum(['issue', 'revoke']) });

/** The lane pool key's routes (issue #1454), for the OpenAPI document. */
export const LANE_POOL_KEY_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/machines/pool-key', tag: 'Machines and usage', summary: 'Whether the session\'s user has a lane pool key', description: 'Issue #1454: `issuedAt` when the user has one the hopper issued, else `{}`. Never the key: only its hash is kept.', role: 'admin', returns: '`{ issuedAt?: string }`' },
  { method: 'post', path: '/ui/api/machines/pool-key', tag: 'Machines and usage', summary: 'Issue or revoke the lane pool key for Pod / Kubernetes', description: 'Issue #1454 (design.md "Lane pods of another release"). `issue`: a new lane pool key for the session\'s user, in place of the one it had, answered once; lane pods of a chart release outside this hopper join with `<hopper URL>#<key>` (POST /client/join) as that user\'s machines, under their pods\' names, with no restart of the hopper. It is not spent: every pod and every restart joins with it. `revoke`: no pod joins with it any more; the machines that joined stay. Only the key\'s hash is kept.', role: 'admin', body: lanePoolKeyBody, returns: '`{ key, issuedAt }`, or `{ revoked }`' },
];

export function registerMachineJoinRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; instance: Pick<InstanceStore, 'joinCodes' | 'lanePoolKeys'>; clock: Clock;
}): void {
  app.post('/ui/api/machines/join', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to add a machine');
    const body = parseWith(machineJoinBody, req.body ?? {});
    const template = joinTemplate(o.tenant(req).vault, body.template);
    return mintJoinCode(o.instance, o.clock, id, template === undefined ? {} : { template });
  });

  app.get('/api/machines/pool-key', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to see your lane pool key');
    const issuedAt = o.instance.lanePoolKeys.issuedAt(id);
    return issuedAt === undefined ? {} : { issuedAt };
  });

  app.post('/ui/api/machines/pool-key', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to add lane pods');
    const body = parseWith(lanePoolKeyBody, req.body ?? {});
    if (body.action === 'revoke') return { revoked: o.instance.lanePoolKeys.remove(id) };
    return issueLanePoolKey(o.instance, o.clock, id);
  });
}
