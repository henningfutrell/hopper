// Access (issue #559): POST /ui/api/access, the instance admin's — approve a template for an operation profile (what
// the vault's gate writes, issue #558), revoke an approval, try a check, set a profile's minimum trust (issue #655), or
// save the model. A change is pushed to OpenFGA before the answer; one it could not take yet is pushed before the next
// check, which denies until then.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessEditError, type Access } from '../../authz/service.ts';
import { OPERATIONS, ASSET_KINDS, ASSET_NAME, TEMPLATE_NAME } from '../../domain/types.ts';
import { MIN_TRUST_LEVELS } from '../../authz/trust.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const template = z.string().regex(TEMPLATE_NAME, 'must be a template name: lowercase letters, digits, . _ -');
const asset = z.strictObject({
  kind: z.enum(ASSET_KINDS),
  name: z.string().regex(ASSET_NAME, 'must be an asset name: letters, digits and . _ / + = , - (an AWS role as <account>/<role>), at most 200 characters'),
});
export const accessEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), template, operation: z.enum(OPERATIONS), asset }),
  z.strictObject({ action: z.literal('revoke'), approval: z.number().int().positive() }),
  z.strictObject({ action: z.literal('check'), template, operation: z.enum(OPERATIONS), asset, level: z.enum(MIN_TRUST_LEVELS).optional() }),
  z.strictObject({ action: z.literal('min-trust'), operation: z.enum(OPERATIONS), asset, level: z.enum(MIN_TRUST_LEVELS).nullable() }),
  z.strictObject({ action: z.literal('model'), dsl: z.string().min(1).max(262_144), version: z.number().int().positive() }),
]);

export function registerAccessRoutes(app: FastifyInstance, o: { instance: Guard; access: Access; by: (req: FastifyRequest) => string }): void {
  app.post('/ui/api/access', o.instance, async (req) => {
    const edit = parseWith(accessEditBody, req.body);
    const by = o.by(req);
    try {
      if (edit.action === 'check') return await o.access.tryCheck(edit, by);
      if (edit.action === 'approve') await o.access.approve(edit.template, { operation: edit.operation, asset: edit.asset }, by);
      else if (edit.action === 'revoke') await o.access.revoke(edit.approval, by);
      else if (edit.action === 'min-trust') await o.access.setMinTrust({ operation: edit.operation, asset: edit.asset }, edit.level, by);
      else await o.access.setModel(edit.dsl, edit.version, by);
    } catch (e) {
      if (e instanceof AccessEditError) throw new HttpError(e.status, e.message);
      throw e;
    }
    const what = edit.action === 'approve' ? `approved ${edit.template} to ${edit.operation} on ${edit.asset.kind} ${edit.asset.name}`
      : edit.action === 'revoke' ? `revoked approval ${edit.approval}`
        : edit.action === 'min-trust' ? `set the minimum trust to ${edit.operation} on ${edit.asset.kind} ${edit.asset.name} to ${edit.level ?? 'none'}` : 'saved the model';
    console.warn(`hopper: access changed in the UI by ${by}: ${what}`);
    return o.access.view();
  });
}

/** Its entry in the API reference (src/http/openapi.ts). */
export const ACCESS_EDIT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/access', tag: 'Access', summary: 'Approve, revoke, try a check, or save the access model', description: 'Only the instance admin (issue #559). `approve` — a template for an operation on an asset (what the vault\'s gate writes, issue #558); `revoke` — an approval by its `id`: the next check is denied; `check` — whether a live job of the template would get the operation on the asset now (a trial, recorded with the answer), its job told at trust `level` (owner when none, issue #655); `min-trust` — the minimum trust of the operation on the asset (`level`; `null` clears it): no job whose trust stamp is below it gets the operation, whatever the approvals say; a box and a person are no job (400 when the model lacks the trust relations); `model` — the access model in OpenFGA DSL, against the `version` read: it must keep every relation the hopper writes or asks, and OpenFGA must take it when it can be asked (400 naming why; 409 when the model moved). A change is pushed to OpenFGA before the answer; one it could not take yet is pushed before the next check, which is denied until then. 404: no such approval.', role: 'admin', body: accessEditBody, returns: 'the new view, as GET /api/access; `check`: the `AccessDecisionRecord`', errors: [403, 404, 409] },
];
