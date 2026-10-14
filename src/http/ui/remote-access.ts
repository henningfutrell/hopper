// Remote access (issues #880, #968, design.md "Remote access"): Settings → Remote access, the hopper's admin's. GET
// /api/remote-access shows the settings, each provider's credential's metadata (never a value), what is minted, the URLs
// an agent calls and the tunnel's status; POST /ui/api/remote-access picks the provider, sets or removes its credential,
// sets the host name and turns it on or off — the hopper mints the tunnel then, or releases it — from the UI or with an
// API token, so a phone needs no access to the host. The tunnel service picks a change up within 10 s.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PROVIDERS, type RemoteAccessView } from '../../domain/remote-access.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import type { RemoteAccess } from '../remote-access.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** Any of the parts; one left out keeps its value. `null` removes the credential, or lets the hopper pick the host name. */
export const remoteAccessBody = z.strictObject({
  enabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  credential: z.string().max(300).nullable().optional(),
  domain: z.string().max(260).nullable().optional(),
  restart: z.literal(true).optional(),
}).refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'name enabled, provider, credential, domain or restart' });

const STATUS = '`status.state`: `off`; `up` (`status.url`: the tunnel there is up); `down` (`status.error`: the tunnel agent\'s last error, or why it is not up); `no-service` (the provider\'s tunnel service did not ask for the settings in the last 30 s, or this hopper has none: `service` false). `status.serviceSeenAt`: that service\'s last ask.';

export const REMOTE_ACCESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/remote-access', tag: 'Remote access', summary: 'Remote access: the tunnel\'s settings and status', description: `Only the instance admin (issues #880, #968). \`enabled\`; \`provider\` (\`cloudflare\` or \`ngrok\`); \`domain\` (the host name asked for; absent: the hopper picks one); \`credentials\`: for each provider, who set its credential, when, and its last 4 characters, never its value; \`provisioned\` and \`url\`: the provider and host name the hopper minted the tunnel at, and its public URL; \`links\` while on: the public URL, the API's base, the API-token exchange and the refresh URL, the URLs an agent calls; \`leftover\`: what the last release could not remove at the provider; \`problem\`: why no credential can be kept now (no master key). ${STATUS}`, returns: '`RemoteAccessView`', errors: [403] },
  { method: 'post', path: '/ui/api/remote-access', tag: 'Remote access', summary: 'Pick the provider, set its credential, turn remote access on or off', description: `Only the instance admin (issues #880, #968). Any of \`provider\` (\`cloudflare\` or \`ngrok\`); \`credential\` (that provider's one credential — a Cloudflare API token with Account → Cloudflare Tunnel → Edit and Zone → DNS → Edit, or an ngrok API key —, kept sealed in the instance's vault as a system secret; \`null\` removes it); \`domain\` (the host name, such as \`hopper.example.com\`; \`null\`: the hopper picks one); \`enabled\`; \`restart: true\` starts the tunnel again with the same settings (\`restartedAt\`); one left out keeps its value. Turned on, the hopper mints the tunnel with the credential: at Cloudflare a named tunnel, its token and a proxied DNS record; at ngrok an authtoken and a domain. Turned off, switched to the other provider or to another host name, or given a new credential, it revokes and removes what it minted first (\`leftover\`: what it could not). 409 to turn it on with no provider or no credential, to remove the credential the tunnel runs on, or to restart while off; 502 when the provider refused (what was minted is removed again, and remote access stays off); 503 when no master key is given. The tunnel service picks a change up within 10 s; a change is \`remote_access.changed\`. ${STATUS}`, role: 'admin', body: remoteAccessBody, returns: '`RemoteAccessView`', errors: [400, 403, 409, 502, 503] },
];

export function registerRemoteAccessRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; remoteAccess: RemoteAccess; by: (req: FastifyRequest) => string }): void {
  app.get('/api/remote-access', async (req): Promise<RemoteAccessView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read remote access');
    return o.remoteAccess.view();
  });
  app.post('/ui/api/remote-access', o.instance, async (req): Promise<RemoteAccessView> => {
    const b = parseWith(remoteAccessBody, req.body);
    return o.remoteAccess.change({
      ...(b.enabled === undefined ? {} : { enabled: b.enabled }), ...(b.provider ? { provider: b.provider } : {}),
      ...(b.credential === undefined ? {} : { credential: b.credential }), ...(b.domain === undefined ? {} : { domain: b.domain }),
      ...(b.restart ? { restart: b.restart } : {}),
    }, o.by(req));
  });
}
