// The machine's terminal (issue #1128, design.md "The machine's terminal"): a person lists the panes of the hopper's herdr
// session on a machine, views one and types into it — a pane no job holds too —, through a UI session or an API token.
// Admin: a pane no job holds may be a shell on the machine. Access decides each use (`machine_terminal#can_attach`); the
// input is a box action. The reads are POSTs: they open a terminal session, an event.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import type { MachineTerminalRefusal } from '../../engine/machine-terminal.ts';
import { TERMINAL_LINES } from '../../engine/terminal.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { terminalInputBody, terminalScreenBody } from './job-terminal.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const pane = { paneId: z.string().min(1).max(200).describe('the pane, as the machine\'s pane list names it') };
const machineScreenBody = terminalScreenBody.extend(pane);
const machineInputBody = terminalInputBody.extend(pane);
const idParams = z.object({ id: z.string() });
const STATUS = { not_found: 404, no_pane: 409, unreachable: 502 } as const;

/** Their operations in the API reference. */
export const MACHINE_TERMINAL_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/machines/:id/terminal/panes', tag: 'Machines and usage', summary: 'List a machine\'s herdr panes', description: 'Issue #1128: every pane of the hopper\'s herdr session on the machine — `paneId`, `tabId`, `title`, `agent`, `agentStatus` and, for a pane a job at work or waiting holds, `jobId` —, read through the machine\'s own connection. Never a path. Access decides (`machine_terminal#can_attach`). 403: Access denies, or OpenFGA cannot be asked. 409: no executor reaches a herdr session there. 502: the machine cannot be reached.', role: 'admin', returns: '`{ machineId, panes }`', errors: [403, 404, 409, 502] },
  { method: 'post', path: '/ui/api/machines/:id/terminal/screen', tag: 'Machines and usage', summary: 'View a pane of a machine\'s herdr session', description: 'Issue #1128: the text the pane `paneId` shows now — its last `lines` lines with the scrollback. Access decides as for the list. The first read opens a terminal session (`terminal.opened`, with `machineId` and `paneId`, and on the job\'s timeline when a job holds the pane); it stays open while it is read or typed into at least every two minutes. 409: the pane is not in the session.', role: 'admin', body: machineScreenBody, returns: '`{ machineId, paneId, sessionId, screen, at }`', errors: [400, 403, 404, 409, 502] },
  { method: 'post', path: '/ui/api/machines/:id/terminal/input', tag: 'Machines and usage', summary: 'Type into a pane of a machine\'s herdr session', description: 'Issue #1128: `text` written to the pane `paneId` as it is, or `keys` pressed, one of the two, as for a job\'s terminal. `terminal.typed` says how many characters, or which keys, never the text. A box action. 400: neither or both, or a key herdr has no name for here.', role: 'admin', body: machineInputBody, returns: '`{ sessionId }`', errors: [400, 403, 404, 409, 502] },
];

export function registerMachineTerminalRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideMachineTerminal'> }): void {
  /** The person signed in, once Access lets them attach to the machine's terminal. */
  const allowed = async (req: FastifyRequest, machineId: string) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to use a machine\'s terminal');
    const d = await o.access.decideMachineTerminal(s.userId, { ownerId: s.userId, machineId });
    if (!d.allowed) throw new HttpError(403, `the machine's terminal is refused: ${d.reason}`);
    return actingOf(s);
  };
  const refused = (r: MachineTerminalRefusal): never => { throw new HttpError(STATUS[r.reason], r.message); };

  app.post('/ui/api/machines/:id/terminal/panes', o.admin, async (req) => {
    const { id } = parseWith(idParams, req.params);
    await allowed(req, id);
    const r = await o.tenant(req).machineTerminal.panes(id);
    if (!r.ok) return refused(r);
    return { machineId: r.machineId, panes: r.panes };
  });
  app.post('/ui/api/machines/:id/terminal/screen', o.admin, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { paneId, lines } = parseWith(machineScreenBody, req.body ?? {});
    const acting = await allowed(req, id);
    const r = await o.tenant(req).machineTerminal.screen(id, paneId, lines ?? TERMINAL_LINES, acting);
    if (!r.ok) return refused(r);
    const { ok: _ok, ...screen } = r;
    return screen;
  });
  app.post('/ui/api/machines/:id/terminal/input', o.admin, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { paneId, text, keys } = parseWith(machineInputBody, req.body ?? {});
    if ((text === undefined) === (keys === undefined)) throw new HttpError(400, 'send text or keys, one of the two');
    const acting = await allowed(req, id);
    const r = await o.tenant(req).machineTerminal.type(id, paneId, text !== undefined ? { text } : { keys: keys! }, acting);
    if (!r.ok) return refused(r);
    return { sessionId: r.sessionId };
  });
}
