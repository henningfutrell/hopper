// Completion reviews (issue #2846, design.md "Completion reviews"): an ended job's review, read at
// GET /api/jobs/:id/completion-review, and which ended jobs are reviewed — an admin's setting, read at
// GET /api/completion-review and changed at POST /ui/api/completion-review. Read by the review pass at each pass, so a
// change applies without a restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { completionReviewSettingsOf, MAX_REVIEW_MIN_RUN_MINUTES, REVIEW_OUTCOMES, type CompletionReview, type CompletionReviewSettings } from '../../domain/completion-review.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const PARTS = ['on', 'outcomes', 'multiJob', 'minRunMinutes'] as const;

/** Any of the parts; one left out keeps its value. */
export const completionReviewBody = z.strictObject({
  on: z.boolean().optional(),
  outcomes: z.array(z.enum(REVIEW_OUTCOMES)).max(REVIEW_OUTCOMES.length).optional(),
  multiJob: z.boolean().optional(),
  minRunMinutes: z.number().min(0).max(MAX_REVIEW_MIN_RUN_MINUTES).optional(),
}).refine((b) => PARTS.some((k) => b[k] !== undefined), { message: `name one of ${PARTS.join(', ')}` });

export const COMPLETION_REVIEW_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/:id/completion-review', tag: 'Jobs', summary: 'An ended job\'s completion review', description: 'Issue #2846: the review the hopper made of the job\'s run after it ended, from its events, its token ledger and its work item\'s jobs; rules only, no model reads the run. `review` absent: the job did not end, ended less than a minute ago, or the settings (`GET /api/completion-review`) skip it. `outcome` (`finished`, `failed`, `cancelled`); `durationMs` from its creation to its end; `stages`, the time in each stage, longest first (`queued`: waiting for a lane; `running`; `person`: a question, or its own wait on an approval, a grant or an infra plan; `waiting`: its own wait on anything else; `parked`); `jobs`, the jobs of its work item; `questions`; `went`, what went well, and `stalls`, where it lost time, in plain words; `restarts` (`requeued`, `preempted`, `parked` by the hopper, `link_lost`, `oom_killed`, `heap_retry`), each with its `count` and first `causes`; `waste`, its waste signals (as on `GET /api/jobs/:id/tokens`); `suggestions`, the changes that would have helped, each with its `area` (`config`, `routing`, `lane`, `template`, `prompt`) and `text`. 404: no such job.', returns: '`{ review?: CompletionReview }`', errors: [404] },
  { method: 'get', path: '/api/completion-review', tag: 'Jobs', summary: 'Which ended jobs get a completion review', description: 'Issue #2846: `on` (default on); `outcomes`, the ends reviewed (`finished`, `failed`, `cancelled`; default `failed`); `multiJob`, a job of a work item that had more than one job is reviewed whatever its end (default on); `minRunMinutes`, a job that ran less than this on its first run is trivial and skipped (default 5).', returns: '`CompletionReviewSettings`' },
  { method: 'post', path: '/ui/api/completion-review', tag: 'Jobs', summary: 'Change which ended jobs get a completion review', description: 'Any of the parts; one left out keeps its value (`completion_review.settings_changed`). `minRunMinutes` from 0 to a day. Applies from the next pass, without a restart; a review already kept stays.', role: 'admin', body: completionReviewBody, returns: '`CompletionReviewSettings`', errors: [400] },
];

export const completionReviewView = (t: Pick<TenantParts, 'store'>): CompletionReviewSettings => completionReviewSettingsOf(t.store.settings.getCompletionReview());

export function registerCompletionReviewRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/completion-review', async (req) => completionReviewView(o.tenant(req)));
  app.get('/api/jobs/:id/completion-review', async (req): Promise<{ review?: CompletionReview }> => {
    const { id } = parseWith(z.object({ id: z.string() }), req.params);
    const { store } = o.tenant(req);
    if (!store.jobs.get(id)) throw new HttpError(404, `job ${id} not found`);
    const review = store.completionReviews.get(id);
    return review ? { review } : {};
  });
  app.post('/ui/api/completion-review', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the completion reviews');
    const t = o.tenant(req);
    const patch = parseWith(completionReviewBody, req.body);
    t.store.tx(() => {
      const from = completionReviewView(t);
      const to: CompletionReviewSettings = {
        on: patch.on ?? from.on, outcomes: patch.outcomes ? REVIEW_OUTCOMES.filter((k) => patch.outcomes!.includes(k)) : from.outcomes,
        multiJob: patch.multiJob ?? from.multiJob, minRunMinutes: patch.minRunMinutes ?? from.minRunMinutes,
      };
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setCompletionReview(to);
      t.store.events.append({ type: 'completion_review.settings_changed', data: { from, to, by: personOf(s) } });
    });
    return completionReviewView(t);
  });
}
