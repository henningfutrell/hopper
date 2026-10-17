// The cloud link (issue #467, design.md "The cloud link"): Settings → hopper.io, the hopper's admin's. GET /api/cloud-link
// shows the link record; POST /ui/api/cloud-link links this install to a hopper.io account, POST /ui/api/cloud-link/unlink
// removes the link. Each applies at once, with no restart. POST /ui/api/cloud-link/registration-code mints the one-time
// code hopper.io's account owner registers the link with (issue #465). GET /api/cloud-link/state shows what hopper.io
// would get: the hopper.io state snapshot this instance makes now (issue #466).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cloudAccountProblem, normalCloudAccount, REGISTRATION_CODE_MINUTES, type CloudLinkView, type RegistrationCodeMinted } from '../../domain/cloud-link.ts';
import type { CloudLink } from '../cloud-link.ts';
import { createHopperIoStateSource } from '../hopper-io-state.ts';
import type { HopperIoState } from '../../domain/hopper-io-state.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const cloudLinkBody = z.strictObject({ account: z.string().max(100) }).superRefine((b, ctx) => {
  const problem = cloudAccountProblem(normalCloudAccount(b.account));
  if (problem) ctx.addIssue({ code: 'custom', path: ['account'], message: problem });
});

export const cloudUnlinkBody = z.strictObject({});

export const registrationCodeBody = z.strictObject({});

const RECORD = '`link`: the link record, or `null` while this install is not linked — `installId` (the instance id, the same at every link, issue #465), `account` (the hopper.io account), `state` (`pending` until it registers, then `registered`), `linkedAt`, `registeredAt` (once registered) and `by`. `registrationCode`, while one is open: `expiresAt` and `by`, never the code.';

export const CLOUD_LINK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/cloud-link', tag: 'Cloud link', summary: 'The link of this install to hopper.io', description: `Only the instance admin (issue #467). ${RECORD}`, returns: '`CloudLinkView`', errors: [403] },
  { method: 'get', path: '/api/cloud-link/state', tag: 'Cloud link', summary: 'What hopper.io would get', description: 'Only the instance admin (issue #466). The hopper.io state snapshot this instance makes now, linked or not: every user\'s machines, lanes, queue and open questions as counts, closed states and an opaque machine key, with the installed version and channel; the schema `HOPPER_IO_STATE_SCHEMA` (`src/domain/hopper-io-state.ts`) holds every field. Here each machine\'s key is `machine-<n>`, its place in the list; the cloud link\'s connection (issue #464) sends its own opaque keys. Reads only: it sends, changes and records nothing.', returns: '`HopperIoState`', errors: [403] },
  { method: 'post', path: '/ui/api/cloud-link', tag: 'Cloud link', summary: 'Link this install to a hopper.io account', description: `Only the instance admin (issue #467). \`account\`: the hopper.io account, letters, digits and single hyphens inside, at most 39 characters, kept trimmed and lowercase. Writes the link record in the instance's settings and nothing else: no data moves, no job or lane stops, no restart. 409 while this install is linked. A link is \`cloud_link.linked\`. ${RECORD}`, role: 'admin', body: cloudLinkBody, returns: '`CloudLinkView`', errors: [400, 403, 409] },
  { method: 'post', path: '/ui/api/cloud-link/registration-code', tag: 'Cloud link', summary: 'Mint a registration code for hopper.io', description: `Only the instance admin (issue #465). Body \`{}\`. A one-time code the hopper.io account owner enters at hopper.io to register this install: answered here once, kept only hashed, for ${REGISTRATION_CODE_MINUTES} minutes, in place of any code before it. 409 while this install is not linked. A mint is \`cloud_link.registration_code_minted\`, with no code.`, role: 'admin', body: registrationCodeBody, returns: '`{ code: string, expiresAt: string }`', errors: [400, 403, 409] },
  { method: 'post', path: '/ui/api/cloud-link/unlink', tag: 'Cloud link', summary: 'Unlink this install from hopper.io', description: 'Only the instance admin (issue #467). Body `{}`. Removes the link record and its registration code, and nothing else; not linked, nothing changes. An unlink is `cloud_link.unlinked`. Answers `{ link: null }`.', role: 'admin', body: cloudUnlinkBody, returns: '`CloudLinkView`', errors: [400, 403] },
];

export function registerCloudLinkRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; cloudLink: CloudLink; hopperIoState: Parameters<typeof createHopperIoStateSource>[0]; by: (req: FastifyRequest) => string }): void {
  const state = createHopperIoStateSource(o.hopperIoState);
  app.get('/api/cloud-link', async (req): Promise<CloudLinkView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the cloud link');
    return o.cloudLink.view();
  });
  app.get('/api/cloud-link/state', async (req): Promise<HopperIoState> => {
    assertInstanceRead(req, o.instanceAdmin, 'read what hopper.io would get');
    return state.snapshot();
  });
  app.post('/ui/api/cloud-link', o.instance, async (req): Promise<CloudLinkView> => o.cloudLink.link(parseWith(cloudLinkBody, req.body).account, o.by(req)));
  app.post('/ui/api/cloud-link/registration-code', o.instance, async (req): Promise<RegistrationCodeMinted> => {
    parseWith(registrationCodeBody, req.body);
    return o.cloudLink.mintRegistrationCode(o.by(req));
  });
  app.post('/ui/api/cloud-link/unlink', o.instance, async (req): Promise<CloudLinkView> => {
    parseWith(cloudUnlinkBody, req.body);
    return o.cloudLink.unlink(o.by(req));
  });
}
