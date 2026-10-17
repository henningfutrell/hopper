// The cloud link (issue #467, design.md "The cloud link"): Settings → hopper.io, the hopper's admin's. GET /api/cloud-link
// shows the link record; POST /ui/api/cloud-link links this install to a hopper.io account, POST /ui/api/cloud-link/unlink
// removes the link. Each applies at once, with no restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cloudAccountProblem, normalCloudAccount, type CloudLinkView } from '../../domain/cloud-link.ts';
import type { CloudLink } from '../cloud-link.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const cloudLinkBody = z.strictObject({ account: z.string().max(100) }).superRefine((b, ctx) => {
  const problem = cloudAccountProblem(normalCloudAccount(b.account));
  if (problem) ctx.addIssue({ code: 'custom', path: ['account'], message: problem });
});

export const cloudUnlinkBody = z.strictObject({});

const RECORD = '`link`: the link record, or `null` while this install is not linked — `installId` (this install\'s id at hopper.io, made at the link), `account` (the hopper.io account), `state` (`pending`: hopper.io has not confirmed the link yet), `linkedAt` and `by`.';

export const CLOUD_LINK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/cloud-link', tag: 'Cloud link', summary: 'The link of this install to hopper.io', description: `Only the instance admin (issue #467). ${RECORD}`, returns: '`CloudLinkView`', errors: [403] },
  { method: 'post', path: '/ui/api/cloud-link', tag: 'Cloud link', summary: 'Link this install to a hopper.io account', description: `Only the instance admin (issue #467). \`account\`: the hopper.io account, letters, digits and single hyphens inside, at most 39 characters, kept trimmed and lowercase. Writes the link record in the instance's settings and nothing else: no data moves, no job or lane stops, no restart. 409 while this install is linked. A link is \`cloud_link.linked\`. ${RECORD}`, role: 'admin', body: cloudLinkBody, returns: '`CloudLinkView`', errors: [400, 403, 409] },
  { method: 'post', path: '/ui/api/cloud-link/unlink', tag: 'Cloud link', summary: 'Unlink this install from hopper.io', description: 'Only the instance admin (issue #467). Body `{}`. Removes the link record and nothing else; not linked, nothing changes. An unlink is `cloud_link.unlinked`. Answers `{ link: null }`.', role: 'admin', body: cloudUnlinkBody, returns: '`CloudLinkView`', errors: [400, 403] },
];

export function registerCloudLinkRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; cloudLink: CloudLink; by: (req: FastifyRequest) => string }): void {
  app.get('/api/cloud-link', async (req): Promise<CloudLinkView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the cloud link');
    return o.cloudLink.view();
  });
  app.post('/ui/api/cloud-link', o.instance, async (req): Promise<CloudLinkView> => o.cloudLink.link(parseWith(cloudLinkBody, req.body).account, o.by(req)));
  app.post('/ui/api/cloud-link/unlink', o.instance, async (req): Promise<CloudLinkView> => {
    parseWith(cloudUnlinkBody, req.body);
    return o.cloudLink.unlink(o.by(req));
  });
}
