// Settings → Windows hosts (issue #731, design.md "Windows sandbox steps"): the Windows hosts a running job's steps run
// on — the config record `windows-hosts`, replaced whole against the version read. Read at each step, so a change
// applies without a restart. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WindowsHostsView } from '../../domain/windows-steps.ts';
import { windowsHostsView, writeWindowsHosts } from '../../windows-steps/index.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// Each host is checked by windowsHostsProblem when it is written.
export const windowsHostsBody = z.strictObject({
  hosts: z.array(z.strictObject({ name: z.string(), label: z.string().optional(), ssh: z.string(), hostKey: z.string(), workDir: z.string() })),
  version: z.string().min(1),
});

export const WINDOWS_HOSTS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/windows-hosts', tag: 'Jobs', summary: 'The Windows hosts', description: 'Issue #731: the Windows hosts a running job\'s Windows sandbox steps run on (`sh "$HOPPER_STEP"`), each a name, an ssh destination, its pinned host key and its working directory; and the record\'s `version`.', returns: '`WindowsHostsView`' },
  { method: 'post', path: '/ui/api/windows-hosts', tag: 'Jobs', summary: 'Replace the Windows hosts', description: 'Issue #731. The whole list, against the `version` read from GET /api/windows-hosts. A host\'s `hostKey` is the one a person confirmed from POST /ui/api/machines/host-key. The next step reads them.', role: 'admin', body: windowsHostsBody, returns: 'the new `WindowsHostsView`', errors: [400, 409] },
];

const STATUS = { invalid: 400, conflict: 409 } as const;

export function registerWindowsHostRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/windows-hosts', async (req): Promise<WindowsHostsView> => windowsHostsView(o.tenant(req).store.config));
  app.post('/ui/api/windows-hosts', o.admin, async (req) => {
    const { hosts, version } = parseWith(windowsHostsBody, req.body);
    const r = writeWindowsHosts(o.tenant(req).store.config, hosts.map(({ label, ...h }) => (label === undefined ? h : { ...h, label })), version);
    if (!r.ok) throw new HttpError(STATUS[r.code], r.error);
    return r.view;
  });
}
