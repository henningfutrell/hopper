// A person's stop of a job's bastion (issue #2146, design.md "Bastions"): the vault's view lists the bastions of the
// user's jobs that start or run now (`bastions`), and a person stops one by its job. A stop is a cancel, not a box
// action: it starts nothing and changes no work. Least role: operator, as a job's cancel. The bastion ends as when its
// job stops it: its tokens released, its box burned, and `bastion.ended` names the person.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { vaultAnswer } from '../vault.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const bastionStopBody = z.strictObject({ job: z.string().min(1).max(64) });

export const BASTION_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/bastions/stop', tag: 'Vault', summary: 'Stop a job\'s bastion', description: 'Issue #2146: stops the bastion of the job `job` that starts or runs now (the vault\'s view lists them in `bastions`), as the job\'s own `bastion stop` does: each relay connection to it closes, its tokens are released, its box is burned, and `bastion.ended` (`reason` `stopped`, `by` the person) is on the job\'s timeline. The job may ask for a bastion again. No box action: it starts nothing. 404: the job has no bastion that runs. Answers the vault\'s view.', role: 'operator', body: bastionStopBody, returns: 'the new view, as GET /api/vault', errors: [400, 404] },
];

export function registerBastionRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/bastions/stop', o.operator, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to stop a bastion');
    const { job } = parseWith(bastionStopBody, req.body);
    const parts = o.tenant(req);
    if (!parts.bastions.stop(job, personOf(s))) throw new HttpError(404, `job ${job} has no bastion that runs`);
    return await vaultAnswer(parts);
  });
}
