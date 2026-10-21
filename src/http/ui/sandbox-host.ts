// The sandbox host (issue #2272, design.md "The sandbox host"): an admin names the machines the user's sandboxes start on,
// first first, or clears it. Each machine of GET /api/machines carries its place (`sandboxHost`), and GET /api/machines
// the list (`sandboxHost`). `hopper machine sandbox-host` posts here. Not a box action: it starts and stops no work.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';
import { SANDBOX_HOSTS_MOST } from '../../domain/sandbox-host.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The machines, first first; empty: clear it. */
export const sandboxHostBody = z.strictObject({ hosts: z.array(z.string().min(1).max(200)).max(SANDBOX_HOSTS_MOST) });

/** Its part of the API reference (src/http/openapi.ts). */
export const SANDBOX_HOST_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/sandbox-host', tag: 'Machines and usage', summary: 'Name the sandbox host', description: `Issue #2272: \`hosts\`, first first, at most ${SANDBOX_HOSTS_MOST}: the machines the user's sandboxes start on — need and box steps, bastions, the read-only check —, the first one online, never another machine. \`local\`: the runtime beside the hopper. A machine with coding lanes is refused (400): set its lanes to 0 first. While none is online, a step waits and its log says \`sandbox host <name> is offline\`. \`[]\` clears it: sandboxes start where they did before. Kept across restarts; a sandbox that runs already ends where it started. One \`machine.sandbox_host_set\` event; none when nothing changes. \`hopper machine sandbox-host\` posts here. 404: no such machine.`, role: 'admin', body: sandboxHostBody, returns: '`{ hosts }`', errors: [400, 401, 404] },
];

export function registerSandboxHostRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/machines/sandbox-host', o.admin, async (req) => {
    const { hosts } = parseWith(sandboxHostBody, req.body);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to name the sandbox host');
    return o.tenant(req).engine.sandboxHost.set(hosts, actingOf(s));
  });
}
