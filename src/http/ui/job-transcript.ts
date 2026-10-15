// The job's transcript (issue #1169 part 4, design.md "The job's transcript"): a person reads the agent session a job's
// latest checkpoint keeps, scrubbed, as turns, a page at a time, through a UI session or an API token. Operator. Access
// decides each read as for the job's terminal (`terminal#can_attach`): the transcript is what the job's pane showed. A
// read, but a POST under /ui/api, as the terminal's screen: it is behind the role guard. A fresh read of a job at work
// (`fresh`, issue #1169 part 7) takes the job's checkpoint first, as the ten-minute pass does, at most once a minute;
// else it changes and records nothing.
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Access } from '../../authz/service.ts';
import type { JobStatus } from '../../domain/types.ts';
import { parseTranscript, transcriptPage, TRANSCRIPT_PAGE, type JobTranscript } from '../../domain/transcript.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const transcriptBody = z.strictObject({
  before: z.number().int().min(0).optional().describe('the turns before this turn (its index); absent: the newest turns'),
  limit: z.number().int().min(1).max(100).optional().describe(`how many turns at most (default ${TRANSCRIPT_PAGE})`),
  fresh: z.boolean().optional().describe('a job at work: take its checkpoint first, when the last one or the last try is a minute old or more'),
});
const idParams = z.object({ id: z.string() });

/** A job at work: its agent session grows on its machine. */
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
/** A fresh read takes a checkpoint at most this often per job: the transcript follows a running job, and each take reads its machine. */
export const TRANSCRIPT_FRESH_MS = 60000;

/** Its operation in the API reference. */
export const JOB_TRANSCRIPT_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/jobs/:id/transcript', tag: 'Jobs', summary: 'Read a job\'s transcript', description: 'Issue #1169: the agent session the job\'s latest checkpoint keeps (issue #921), scrubbed, as turns: each a `prompt` and the `parts` the agent made after it, in order — `text`, `reasoning`, `tool` (its `title`, `input`, `result`, `error`), `plan` (its `items`) and `subagent` (its `title`, `agent`, `prompt`, `result`). A long text, input or result is cut and says `truncated`. The newest `limit` turns before turn `before`; `start` is the first one\'s index, `total` how many there are. Access decides as for the job\'s terminal (`terminal#can_attach`). With `fresh`, for a job at work, it takes the job\'s checkpoint first (as the ten-minute pass does: `job.checkpointed`) when its last checkpoint, or the last fresh try, is a minute old or more; when none can be taken, `stale` says why and the turns are the kept checkpoint\'s. Else it changes and records nothing. 403: Access denies, or OpenFGA cannot be asked. 409: the job\'s checkpoint keeps no agent session (with `fresh`, and why none was taken).', role: 'operator', body: transcriptBody, returns: '`JobTranscript` `{ jobId, checkpointAt, total, start, turns, stale? }`', errors: [400, 403, 404, 409] },
];

export function registerJobTranscriptRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; access: Pick<Access, 'decideTerminal'> }): void {
  /** Each job's last fresh try: when, and why it took no checkpoint. A machine that cannot be reached is asked once a minute. */
  const tried = new Map<string, { at: number; why?: string }>();
  app.post('/ui/api/jobs/:id/transcript', o.operator, async (req): Promise<JobTranscript> => {
    const { id } = parseWith(idParams, req.params);
    const { fresh, ...page } = parseWith(transcriptBody, req.body ?? {});
    const { store, engine } = o.tenant(req);
    const job = store.jobs.get(id);
    if (!job) throw new HttpError(404, `job ${id} not found`);
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to read a job\'s transcript');
    const d = await o.access.decideTerminal(s.userId, { ownerId: s.userId, jobId: id });
    if (!d.allowed) throw new HttpError(403, `the job's transcript is refused: ${d.reason}`);
    let stale: string | undefined;
    if (fresh && AT_WORK.includes(job.status)) {
      const now = Date.now();
      const last = tried.get(id);
      const taken = job.checkpoint ? Date.parse(job.checkpoint.at) : 0;
      if (now - Math.max(taken, last?.at ?? 0) >= TRANSCRIPT_FRESH_MS) {
        const got = await engine.checkpoints.take(id);
        stale = typeof got === 'string' ? got : undefined;
        tried.set(id, { at: now, ...(stale ? { why: stale } : {}) });
      } else if (last && last.at > taken) stale = last.why;
      for (const [k, t] of tried) if (now - t.at >= TRANSCRIPT_FRESH_MS) tried.delete(k);
    }
    const k = store.checkpoints.get(id);
    if (!k?.session) throw new HttpError(409, `job ${id}'s checkpoint keeps no agent session${stale ? `: ${stale}` : ''}`);
    return { jobId: id, checkpointAt: k.at, ...transcriptPage(parseTranscript(gunzipSync(k.session).toString('utf8')), page), ...(stale ? { stale } : {}) };
  });
}
