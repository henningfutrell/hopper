// Asking on the issue thread (issue #435, design.md "The hopper label means full automation"): the policy for posting a
// GitHub job's question on its issue — for repositories the connected account owns and for any other, `post`, `review`
// or `off` — an admin's, read at each sync, so a change applies without a restart (GET /api/thread-ask); and a person's
// approval of a question held for review, which the next pass of its source posts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_THREAD_ASK, THREAD_ASK_POLICIES, type ThreadAskPolicy, type ThreadAskSettings } from '../../domain/types.ts';
import { HttpError, parseWith } from '../errors.ts';
import { questionView } from '../questions.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const policy = z.enum(THREAD_ASK_POLICIES as [ThreadAskPolicy, ...ThreadAskPolicy[]]);
/** Either policy; one left out keeps its value. */
export const threadAskBody = z.strictObject({ ownRepos: policy.optional(), otherRepos: policy.optional() })
  .refine((b) => b.ownRepos !== undefined || b.otherRepos !== undefined, { message: 'name ownRepos or otherRepos' });

export const threadAskView = (t: Pick<TenantParts, 'store'>): ThreadAskSettings => t.store.settings.getThreadAsk() ?? DEFAULT_THREAD_ASK;

const idParams = z.object({ id: z.string() });

export function registerThreadAskRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const by = (req: FastifyRequest, what: string): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, `sign in to ${what}`);
    return personOf(s);
  };

  app.post('/ui/api/thread-ask', o.admin, async (req) => {
    const who = by(req, 'change asking on the issue thread');
    const t = o.tenant(req);
    const patch = parseWith(threadAskBody, req.body);
    t.store.tx(() => {
      const from = threadAskView(t);
      const to: ThreadAskSettings = { ownRepos: patch.ownRepos ?? from.ownRepos, otherRepos: patch.otherRepos ?? from.otherRepos };
      if (from.ownRepos === to.ownRepos && from.otherRepos === to.otherRepos) return;
      t.store.settings.setThreadAsk(to);
      t.store.events.append({ type: 'thread_ask.settings_changed', data: { from, to, by: who } });
    });
    return threadAskView(t);
  });

  // A question held for review goes on its issue thread: `question.thread_approved` starts its job's pass, which posts it.
  app.post('/ui/api/questions/:id/thread-approve', o.operator, async (req) => {
    const who = by(req, 'approve a question for the issue thread');
    const { id } = parseWith(idParams, req.params);
    const t = o.tenant(req);
    const q = t.store.tx(() => {
      const found = t.store.questions.get(id);
      if (!found) throw new HttpError(404, `question ${id} not found`);
      if (found.status !== 'open' || found.thread?.state !== 'review') throw new HttpError(409, `question ${id} is not open and held for review`);
      const updated = t.store.questions.update(id, { thread: { ...found.thread, state: 'approved', at: new Date().toISOString(), approvedBy: who } });
      t.store.events.append({ type: 'question.thread_approved', jobId: found.jobId, questionId: id, data: { questionId: id, by: who } });
      return updated;
    });
    return questionView(t, q);
  });
}
