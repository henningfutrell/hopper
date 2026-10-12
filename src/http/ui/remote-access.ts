// Remote access (issue #880, design.md "Remote access"): Settings → Remote access, the hopper's admin's. GET
// /api/remote-access shows the settings, the authtoken's metadata (never its value) and the tunnel's status; POST
// /ui/api/remote-access turns it on or off, sets the domain reserved at ngrok, and sets or removes the authtoken — from the
// UI or with an API token, so a phone needs no access to the host. The tunnel service picks a change up within 10 s.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RemoteAccessView } from '../../domain/remote-access.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import type { RemoteAccess } from '../remote-access.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** Any of the parts; one left out keeps its value. `null` removes the domain or the authtoken (remote access off). */
export const remoteAccessBody = z.strictObject({
  enabled: z.boolean().optional(),
  domain: z.string().max(260).nullable().optional(),
  authtoken: z.string().max(300).nullable().optional(),
  restart: z.literal(true).optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'name enabled, domain, authtoken or restart' });

const STATUS = '`status.state`: `off`; `up` (`status.url`: the tunnel\'s endpoint there is up); `down` (`status.error`: ngrok\'s last error, or why the tunnel agent has no endpoint at the URL); `no-service` (no tunnel service asked for the settings in the last 30 s, or this hopper has none: `service` false). `status.serviceSeenAt`: the tunnel service\'s last ask.';

export const REMOTE_ACCESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/remote-access', tag: 'Remote access', summary: 'Remote access: the tunnel\'s settings and status', description: `Only the instance admin (issue #880). \`enabled\`, \`domain\` (reserved at ngrok) and \`url\` (\`https://<domain>\`, the public URL of the tunnel); \`authtoken\`: who set the ngrok authtoken, when, and its last 4 characters, never its value; absent: none is kept. \`problem\`: why no authtoken can be kept now (no master key). ${STATUS}`, returns: '`RemoteAccessView`', errors: [403] },
  { method: 'post', path: '/ui/api/remote-access', tag: 'Remote access', summary: 'Turn remote access on or off, set its domain and its ngrok authtoken', description: `Only the instance admin (issue #880). Any of \`enabled\`, \`domain\` (the domain reserved at ngrok, such as \`hopper.example.ngrok.app\`; \`null\` removes it) and \`authtoken\` (the ngrok authtoken, kept sealed in the instance's vault as the system secret \`remote-access.ngrok-authtoken\`; \`null\` removes it); \`restart: true\` starts ngrok again with the same settings (\`restartedAt\`); one left out keeps its value. 409 when remote access would be on without a domain or an authtoken, or a restart while it is off; 503 when no master key is given. The tunnel service picks a change up within 10 s and starts ngrok again; a change is \`remote_access.changed\`. ${STATUS}`, role: 'admin', body: remoteAccessBody, returns: '`RemoteAccessView`', errors: [400, 403, 409, 503] },
];

export function registerRemoteAccessRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; remoteAccess: RemoteAccess; by: (req: FastifyRequest) => string }): void {
  app.get('/api/remote-access', async (req): Promise<RemoteAccessView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read remote access');
    return o.remoteAccess.view();
  });
  app.post('/ui/api/remote-access', o.instance, async (req): Promise<RemoteAccessView> => {
    const { enabled, domain, authtoken, restart } = parseWith(remoteAccessBody, req.body);
    return o.remoteAccess.change({ ...(enabled === undefined ? {} : { enabled }), ...(domain === undefined ? {} : { domain }), ...(authtoken === undefined ? {} : { authtoken }), ...(restart ? { restart } : {}) }, o.by(req));
  });
}
