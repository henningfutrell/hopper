// Machine credential acceptance routes (issue #1459): accept or revoke a machine whose job user holds infra credentials.
// The admin accepts the blast-radius risk; the machine takes jobs despite the credentials.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const acceptBody = z.strictObject({
  machineKey: z.string().min(1),
  credentials: z.array(z.string()),
});

export const revokeBody = z.strictObject({
  machineKey: z.string().min(1),
});

export function registerMachineCredentialRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock;
}): void {
  app.post('/ui/api/machines/:id/credentials/accept', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to accept machine credentials');
    const body = parseWith(acceptBody, req.body ?? {});
    const { store } = o.tenant(req);
    store.credentialAcceptances.accept(body.machineKey, body.credentials, id, o.clock.now().toISOString());
    return { ok: true };
  });

  app.post('/ui/api/machines/:id/credentials/revoke', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to revoke machine credentials');
    const body = parseWith(revokeBody, req.body ?? {});
    const { store } = o.tenant(req);
    store.credentialAcceptances.revoke(body.machineKey, o.clock.now().toISOString());
    return { ok: true };
  });
}

// These are box actions: an API token needs a box grant (issue #795).
import { type BoxAction } from './box-actions.ts';

const BOX_ACTIONS_EXTEND: readonly BoxAction[] = [
  { route: '/ui/api/machines/:id/credentials/accept', kind: 'change work on a machine' },
  { route: '/ui/api/machines/:id/credentials/revoke', kind: 'change work on a machine' },
];

export { BOX_ACTIONS_EXTEND };

/** The API reference's entries for these routes (src/http/openapi.ts). */
export const MACHINE_CREDENTIAL_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/:id/credentials/accept', tag: 'Machines and usage', summary: 'Use a machine anyway though its job user holds infra credentials (issue #1459)', description: 'Records the admin\'s acceptance of the blast radius for `machineKey`: the readiness gate (issue #1248) holds the machine no longer and it takes jobs. Its warning stays shown until the acceptance is revoked.', role: 'admin', body: acceptBody, returns: '`{ ok: true }`', errors: [401] },
  { method: 'post', path: '/ui/api/machines/:id/credentials/revoke', tag: 'Machines and usage', summary: 'Take back a machine\'s credential acceptance (issue #1459)', description: 'The machine takes no jobs again while its job user holds infra credentials.', role: 'admin', body: revokeBody, returns: '`{ ok: true }`', errors: [401] },
];
