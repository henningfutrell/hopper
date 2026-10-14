// Allowed hosts (issue #1024, design.md "Reaching the UI across a tailnet"): Settings → Allowed hosts, the hopper's admin's.
// GET /api/allowed-hosts shows the hosts the admin allowed, the LAN names and this host's tailnet as the hopper found it;
// POST /ui/api/allowed-hosts keeps the whole list, from the UI or with an API token, never from a file. It applies at once.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ALLOWED_HOSTS_MAX, allowedHostProblem, normalHosts, type AllowedHostsView } from '../../domain/allowed-hosts.ts';
import type { AllowedHosts } from '../allowed-hosts.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The whole list: host names or addresses, no port. */
export const allowedHostsBody = z.strictObject({ hosts: z.array(z.string().max(300)).max(ALLOWED_HOSTS_MAX) })
  .superRefine((b, ctx) => {
    for (const h of normalHosts(b.hosts)) {
      const problem = allowedHostProblem(h);
      if (problem) ctx.addIssue({ code: 'custom', path: ['hosts'], message: problem });
    }
  });

export const ALLOWED_HOSTS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/allowed-hosts', tag: 'Remote access', summary: 'The hosts the UI answers to', description: 'Only the instance admin (issue #1024). `hosts`: the hosts the admin allowed; `lan`: the LAN names (`HOPPER_LAN_NAMES`); `tailnet`: whether this host is on a Tailscale tailnet, and its MagicDNS name, the name\'s first label and its addresses there, as the hopper found them (read again every minute); `port`: the port each is answered on. A request that names any of them with the port is a LAN request: it reads `/api/` only with a UI session or a token.', returns: '`AllowedHostsView`', errors: [403] },
  { method: 'post', path: '/ui/api/allowed-hosts', tag: 'Remote access', summary: 'Set the allowed hosts', description: `Only the instance admin (issue #1024). \`hosts\`, the whole list: host names or IPv4 or IPv6 addresses, no port and no scheme, at most ${ALLOWED_HOSTS_MAX}; kept trimmed, lowercase, each once. Loopback is always allowed and is refused here. Applies at once, without a restart; a change is \`allowed_hosts.changed\`. A peer must still be on loopback, in \`HOPPER_LAN_PEERS\` or on this host's tailnet.`, role: 'admin', body: allowedHostsBody, returns: '`AllowedHostsView`', errors: [400, 403] },
];

export function registerAllowedHostsRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; allowedHosts: AllowedHosts; by: (req: FastifyRequest) => string }): void {
  app.get('/api/allowed-hosts', async (req): Promise<AllowedHostsView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the allowed hosts');
    return o.allowedHosts.view();
  });
  app.post('/ui/api/allowed-hosts', o.instance, async (req): Promise<AllowedHostsView> => {
    const { hosts } = parseWith(allowedHostsBody, req.body);
    return o.allowedHosts.change(hosts, o.by(req));
  });
}
