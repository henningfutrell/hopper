// The Windows link report (issue #712, design.md "Machine resources over time" → "The Windows link", the path "The
// Windows keep-alive loop reports the Windows link"): the keep-alive loop on Windows tests whether Windows opens the
// hopper at localhost, and reports what it found through the operator CLI (`hopper windows-link report`), which makes
// this one call under a UI session of its own. An admin's. The hopper stamps the time, keeps the report in memory (GET
// /api/machines carries it for 15 minutes), and the Windows link watch tells a broken link once, as the machine
// `windows`. It changes no job, question, webhook or setting, and nothing is kept in the database.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../../domain/ports.ts';
import { WINDOWS_LINK_URL } from '../../domain/machine-history.ts';
import type { WindowsLink } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** WSL's networking mode, as wslinfo says it. */
export const NETWORKING_MODE = /^[a-z]{1,20}$/;
/** The longest reason kept. */
export const MAX_WINDOWS_LINK_ERROR = 200;

/** What Windows found: the HTTP status the hopper answered with (any status: it answered), or why it got no answer. */
export const windowsLinkBody = z.strictObject({
  url: z.string().regex(WINDOWS_LINK_URL, 'the address check at localhost or 127.0.0.1: http://localhost:<port>/job/address'),
  mode: z.string().regex(NETWORKING_MODE, 'a networking mode, as wslinfo says it').optional(),
  status: z.number().int().min(100).max(599).optional(),
  error: z.string().trim().min(1).max(MAX_WINDOWS_LINK_ERROR).optional(),
}).refine((b) => (b.status === undefined) !== (b.error === undefined), 'either status or error, not both');

export const WINDOWS_LINK_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/windows-link', tag: 'Machines and usage', summary: 'Report the Windows link', description: 'Issue #712. What the keep-alive loop on Windows found when Windows opened the hopper\'s address check (`/job/address`) at localhost, else at 127.0.0.1 (`url`: the one that answered), sent through `hopper windows-link report`: `status`, the HTTP status the hopper answered with (any status means it answered), or `error`, why there was no answer; `mode`, WSL\'s networking mode. The hopper stamps the time and keeps it in memory: GET /api/machines carries it as `windowsLink` for 15 minutes, and a broken link is told once as `machine.windows_link_broken` with `machineId` `windows`, then `machine.windows_link_restored`.', role: 'admin', body: windowsLinkBody, returns: '`{ windowsLink: WindowsLink }`', errors: [400] },
];

export function registerWindowsLinkRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.post('/ui/api/windows-link', o.admin, async (req) => {
    const b = parseWith(windowsLinkBody, req.body);
    const windowsLink: WindowsLink = {
      url: b.url, ...(b.mode ? { mode: b.mode } : {}), ok: b.status !== undefined,
      ...(b.status !== undefined ? { status: b.status } : {}), ...(b.error ? { error: b.error } : {}), at: o.clock.now().toISOString(),
    };
    o.tenant(req).windowsLink.report(windowsLink);
    return { windowsLink };
  });
}
