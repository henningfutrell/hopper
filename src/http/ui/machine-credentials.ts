// Machine credential acceptance routes (issue #1459): accept or revoke a machine whose job user holds infra credentials.
// The admin accepts the blast-radius risk; the machine takes jobs despite the credentials.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import { HttpError, parseWith } from '../errors.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';
import { BOX_ACTIONS } from './box-actions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const acceptBody = z.strictObject({
  machineKey: z.string().min(1),
  credentials: z.array(z.string()),
});

const revokeBody = z.strictObject({
  machineKey: z.string().min(1),
});

export function registerMachineCredentialRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock;
}): void {
  app.post('/ui/api/machines/:id/credentials/accept', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to accept machine credentials');
    const { id: machineId } = req.params as { id: string };
    const body = parseWith(acceptBody, req.body ?? {});
    const { store } = o.tenant(req);
    store.credentialAcceptances.accept(body.machineKey, body.credentials, id, o.clock.now().toISOString());
    return { ok: true };
  });

  app.post('/ui/api/machines/:id/credentials/revoke', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to revoke machine credentials');
    const { id: machineId } = req.params as { id: string };
    const body = parseWith(revokeBody, req.body ?? {});
    const { store } = o.tenant(req);
    store.credentialAcceptances.revoke(body.machineKey, o.clock.now().toISOString());
    return { ok: true };
  });
}

// These are box actions: an API token needs a box grant (issue #795).
const BOX_ACTIONS_EXTEND: readonly BoxAction[] = [
  { route: '/ui/api/machines/:id/credentials/accept', kind: 'change work on a machine' },
  { route: '/ui/api/machines/:id/credentials/revoke', kind: 'change work on a machine' },
];

export { BOX_ACTIONS_EXTEND };
