// Access (issue #559): POST /ui/api/access, the instance admin's — approve a template for an operation profile (what
// the vault's gate writes, issue #558), revoke an approval, try a check, or save the model. A change is pushed to
// OpenFGA before the answer; one it could not take yet is pushed before the next check, which denies until then.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessEditError, type Access } from '../../authz/service.ts';
import { OPERATIONS, ASSET_KINDS, ASSET_NAME, TEMPLATE_NAME } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const template = z.string().regex(TEMPLATE_NAME, 'must be a template name: lowercase letters, digits, . _ -');
const asset = z.strictObject({
  kind: z.enum(ASSET_KINDS),
  name: z.string().regex(ASSET_NAME, 'must be an asset name: letters, digits and . _ / + = , - (an AWS role as <account>/<role>), at most 200 characters'),
});
export const accessEditBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('approve'), template, operation: z.enum(OPERATIONS), asset }),
  z.strictObject({ action: z.literal('revoke'), approval: z.number().int().positive() }),
  z.strictObject({ action: z.literal('check'), template, operation: z.enum(OPERATIONS), asset }),
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
      else await o.access.setModel(edit.dsl, edit.version, by);
    } catch (e) {
      if (e instanceof AccessEditError) throw new HttpError(e.status, e.message);
      throw e;
    }
    const what = edit.action === 'approve' ? `approved ${edit.template} to ${edit.operation} on ${edit.asset.kind} ${edit.asset.name}`
      : edit.action === 'revoke' ? `revoked approval ${edit.approval}` : 'saved the model';
    console.warn(`hopper: access changed in the UI by ${by}: ${what}`);
    return o.access.view();
  });
}
