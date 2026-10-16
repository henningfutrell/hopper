// Add machine's route. Issue #308: a one-time join code, for the session's user: the line the machine runs carries it
// (design.md "Joining a machine"); only the code's hash is written, the machine's join adds it. A sandbox never joins as a
// machine (issue #1349): a job's step runs in a sandbox of its own, burned after it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, InstanceStore } from '../../domain/ports.ts';
import { mintJoinCode } from '../../machines/join-code.ts';
import { HttpError, parseWith } from '../errors.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';
import { joinTemplate } from './vault.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** `template`: the template the machine joins as (issue #558). */
export const machineJoinBody = z.strictObject({ template: z.string().min(1).max(64).optional() });

export function registerMachineJoinRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; instance: Pick<InstanceStore, 'joinCodes'>; clock: Clock;
}): void {
  app.post('/ui/api/machines/join', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to add a machine');
    const body = parseWith(machineJoinBody, req.body ?? {});
    const template = joinTemplate(o.tenant(req).vault, body.template);
    return mintJoinCode(o.instance, o.clock, id, template === undefined ? {} : { template });
  });
}
