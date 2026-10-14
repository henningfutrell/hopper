// The job's terminal (issue #1128, design.md "The job's terminal"): a person views a running job's herdr pane and types into
// it, through a UI session or an API token. Operator. Access decides each use (`terminal#can_attach`); the input is a box
// action (it changes work on a machine). The read is a POST: it opens a terminal session, an event on the job's timeline.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import { TERMINAL_KEYS, TERMINAL_LINES, TERMINAL_MAX_LINES, TERMINAL_MAX_TEXT, type TerminalRefusal } from '../../engine/terminal.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { actingOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const terminalScreenBody = z.strictObject({
  lines: z.number().int().min(1).max(TERMINAL_MAX_LINES).optional().describe(`how many of the pane's last lines, with its scrollback (default ${TERMINAL_LINES})`),
});
export const terminalInputBody = z.strictObject({
  text: z.string().min(1).max(TERMINAL_MAX_TEXT).optional().describe('text written to the pane as it is; a newline in it is not Enter'),
  keys: z.array(z.enum(TERMINAL_KEYS)).min(1).max(32).optional().describe('keys pressed, in order, by herdr\'s key names'),
});
const idParams = z.object({ id: z.string() });
const STATUS = { not_found: 404, no_pane: 409, unreachable: 502 } as const;

/** Their operations in the API reference. */
export const JOB_TERMINAL_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/jobs/:id/terminal/screen', tag: 'Jobs', summary: 'View a job\'s terminal', description: `Issue #1128: the text the job's herdr pane shows now — its last \`lines\` lines with the scrollback — read through the job's own machine connection (this machine, ssh, or the machine's client). Only a job at work or waiting (on a question, on its own wait) holds its pane. Access decides (\`terminal#can_attach\`, the job's owner). The first read opens a terminal session (\`terminal.opened\`); it stays open while it is read or typed into at least every two minutes. 403: Access denies, or OpenFGA cannot be asked. 409: the job holds no pane, or its executor has none. 502: its machine cannot be reached.`, role: 'operator', body: terminalScreenBody, returns: '`{ jobId, sessionId, screen, at }`', errors: [400, 403, 404, 409, 502] },
  { method: 'post', path: '/ui/api/jobs/:id/terminal/input', tag: 'Jobs', summary: 'Type into a job\'s terminal', description: `Issue #1128: \`text\` written to the job's herdr pane as it is (at most ${TERMINAL_MAX_TEXT} characters), or \`keys\` pressed (${TERMINAL_KEYS.join(', ')}), one of the two. Access decides as for the view. \`terminal.typed\` says how many characters, or which keys, never the text. A box action. 400: neither or both, or a key herdr has no name for here. 403, 409, 502: as for the view.`, role: 'operator', body: terminalInputBody, returns: '`{ sessionId }`', errors: [400, 403, 404, 409, 502] },
];

export function registerJobTerminalRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideTerminal'> }): void {
  /** The person signed in, once Access lets them attach to the job's terminal. */
  const allowed = async (req: FastifyRequest, jobId: string) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to use a job\'s terminal');
    const d = await o.access.decideTerminal(s.userId, { ownerId: s.userId, jobId });
    if (!d.allowed) throw new HttpError(403, `the job's terminal is refused: ${d.reason}`);
    return actingOf(s);
  };
  const refused = (r: TerminalRefusal): never => { throw new HttpError(STATUS[r.reason], r.message); };

  app.post('/ui/api/jobs/:id/terminal/screen', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { lines } = parseWith(terminalScreenBody, req.body ?? {});
    const acting = await allowed(req, id);
    const r = await o.tenant(req).terminal.screen(id, lines ?? TERMINAL_LINES, acting);
    if (!r.ok) return refused(r);
    const { ok: _ok, ...screen } = r;
    return screen;
  });
  app.post('/ui/api/jobs/:id/terminal/input', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { text, keys } = parseWith(terminalInputBody, req.body ?? {});
    if ((text === undefined) === (keys === undefined)) throw new HttpError(400, 'send text or keys, one of the two');
    const acting = await allowed(req, id);
    const r = await o.tenant(req).terminal.type(id, text !== undefined ? { text } : { keys: keys! }, acting);
    if (!r.ok) return refused(r);
    return { sessionId: r.sessionId };
  });
}
