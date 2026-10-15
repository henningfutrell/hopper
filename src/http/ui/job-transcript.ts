// The job's transcript (issue #1169 part 4, design.md "The job's transcript"): a person reads the agent session a job's
// latest checkpoint keeps, scrubbed, as turns, a page at a time, through a UI session or an API token. Operator. Access
// decides each read as for the job's terminal (`terminal#can_attach`): the transcript is what the job's pane showed. A
// read, but a POST under /ui/api, as the terminal's screen: it is behind the role guard. It changes and records nothing.
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import { parseTranscript, transcriptPage, TRANSCRIPT_PAGE, type JobTranscript } from '../../domain/transcript.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const transcriptBody = z.strictObject({
  before: z.number().int().min(0).optional().describe('the turns before this turn (its index); absent: the newest turns'),
  limit: z.number().int().min(1).max(100).optional().describe(`how many turns at most (default ${TRANSCRIPT_PAGE})`),
});
const idParams = z.object({ id: z.string() });

/** Its operation in the API reference. */
export const JOB_TRANSCRIPT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/jobs/:id/transcript', tag: 'Jobs', summary: 'Read a job\'s transcript', description: 'Issue #1169: the agent session the job\'s latest checkpoint keeps (issue #921), scrubbed, as turns: each a `prompt` and the `parts` the agent made after it, in order — `text`, `reasoning`, `tool` (its `title`, `input`, `result`, `error`), `plan` (its `items`) and `subagent` (its `title`, `agent`, `prompt`, `result`). A long text, input or result is cut and says `truncated`. The newest `limit` turns before turn `before`; `start` is the first one\'s index, `total` how many there are. Access decides as for the job\'s terminal (`terminal#can_attach`). It changes and records nothing. 403: Access denies, or OpenFGA cannot be asked. 409: the job\'s checkpoint keeps no agent session.', role: 'operator', body: transcriptBody, returns: '`JobTranscript` `{ jobId, checkpointAt, total, start, turns }`', errors: [400, 403, 404, 409] },
];

export function registerJobTranscriptRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideTerminal'> }): void {
  app.post('/ui/api/jobs/:id/transcript', o.operator, async (req): Promise<JobTranscript> => {
    const { id } = parseWith(idParams, req.params);
    const page = parseWith(transcriptBody, req.body ?? {});
    const { store } = o.tenant(req);
    if (!store.jobs.get(id)) throw new HttpError(404, `job ${id} not found`);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to read a job\'s transcript');
    const d = await o.access.decideTerminal(s.userId, { ownerId: s.userId, jobId: id });
    if (!d.allowed) throw new HttpError(403, `the job's transcript is refused: ${d.reason}`);
    const k = store.checkpoints.get(id);
    if (!k?.session) throw new HttpError(409, `job ${id}'s checkpoint keeps no agent session`);
    return { jobId: id, checkpointAt: k.at, ...transcriptPage(parseTranscript(gunzipSync(k.session).toString('utf8')), page) };
  });
}
