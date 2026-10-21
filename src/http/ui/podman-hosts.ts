// Settings → Podman hosts (issue #2272, design.md "Podman hosts"): the computers with rootless Podman the user's
// sandboxes may start on, reached over ssh — the config record `podman-hosts`, replaced whole against the version read.
// The sandbox host names one to use it. Read at each sandbox, so a change applies without a restart. Least role to
// change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PodmanHostsView } from '../../domain/podman-hosts.ts';
import { podmanHostsView, writePodmanHosts } from '../../sandbox/podman-hosts.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// Each host is checked by podmanHostsProblem when it is written.
export const podmanHostsBody = z.strictObject({
  hosts: z.array(z.strictObject({ name: z.string(), label: z.string().optional(), ssh: z.string(), hostKey: z.string(), cpus: z.number().optional(), memoryMb: z.number().optional() })),
  version: z.string().min(1),
});

export const PODMAN_HOSTS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/podman-hosts', tag: 'Machines and usage', summary: 'The Podman hosts', description: 'Issue #2272: the computers with rootless Podman the user\'s sandboxes may start on, reached over ssh (`podman system dial-stdio`), each a name, an ssh destination, its pinned host key, and the most CPUs and memory a box gets there; and the record\'s `version`. The sandbox host names one to use it.', returns: '`PodmanHostsView`' },
  { method: 'post', path: '/ui/api/podman-hosts', tag: 'Machines and usage', summary: 'Replace the Podman hosts', description: 'Issue #2272. The whole list, against the `version` read from GET /api/podman-hosts. A host\'s `hostKey` is the one a person confirmed from POST /ui/api/machines/host-key. The next sandbox reads them. `hopper machine podman-host` posts here.', role: 'admin', body: podmanHostsBody, returns: 'the new `PodmanHostsView`', errors: [400, 409] },
];

const STATUS = { invalid: 400, conflict: 409 } as const;

export function registerPodmanHostRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/podman-hosts', async (req): Promise<PodmanHostsView> => podmanHostsView(o.tenant(req).store.config));
  app.post('/ui/api/podman-hosts', o.admin, async (req) => {
    const { hosts, version } = parseWith(podmanHostsBody, req.body);
    const r = writePodmanHosts(o.tenant(req).store.config, hosts.map(({ label, cpus, memoryMb, ...h }) => ({ ...h, ...(label === undefined ? {} : { label }), ...(cpus === undefined ? {} : { cpus }), ...(memoryMb === undefined ? {} : { memoryMb }) })), version);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return r.view;
  });
}
