// Completion reviews (issue #2846, design.md "Completion reviews"): an ended job's review, read at
// GET /api/jobs/:id/completion-review with the model's review beside it (issue #2846 part 3), and which ended jobs are reviewed — an admin's setting, read at
// GET /api/completion-review and changed at POST /ui/api/completion-review. Read by the review pass at each pass, so a
// change applies without a restart. The bug-report recommendations (issue #2846 part 2): listed at
// GET /api/completion-review/recommendations; Approve sends one to Report a bug as a report of the job whose review found it —
// its private work removed, scrubbed, masked, with the resend key of its signature (`bugReportsOf`, src/bug-reports/) — and
// sends that report at once, as a person's approval of a job's report does; Dismiss keeps the reason, and the signature is
// never recommended again. Nothing is filed without Approve.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BugReportRefused, keyedReportId } from '../../bug-reports/index.ts';
import { RECOMMENDATION_STATES, type BugReportRecommendation } from '../../domain/review-defects.ts';
import { completionReviewSettingsOf, MAX_MODEL_REVIEW_DAILY_USD, MAX_REVIEW_MIN_RUN_MINUTES, REVIEW_OUTCOMES, type CompletionReview, type CompletionReviewSettings } from '../../domain/completion-review.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { bugReportsOf } from './bug-reports.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const PARTS = ['on', 'outcomes', 'multiJob', 'minRunMinutes', 'modelReview'] as const;

/** Any of the parts; one left out keeps its value. */
export const completionReviewBody = z.strictObject({
  on: z.boolean().optional(),
  outcomes: z.array(z.enum(REVIEW_OUTCOMES)).max(REVIEW_OUTCOMES.length).optional(),
  multiJob: z.boolean().optional(),
  minRunMinutes: z.number().min(0).max(MAX_REVIEW_MIN_RUN_MINUTES).optional(),
  modelReview: z.strictObject({
    on: z.boolean().optional(),
    model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, 'a model name: letters, digits, ., _, :, [, ], -').optional(),
    dailyCostUsd: z.number().min(0).max(MAX_MODEL_REVIEW_DAILY_USD).optional(),
  }).optional(),
}).refine((b) => PARTS.some((k) => b[k] !== undefined), { message: `name one of ${PARTS.join(', ')}` });

export const recommendationBody = z.strictObject({ signature: z.string().min(1).max(200) });
export const dismissRecommendationBody = z.strictObject({ signature: z.string().min(1).max(200), reason: z.string().trim().min(1, 'say why').max(500) });
const recommendationQuery = z.object({ state: z.enum(RECOMMENDATION_STATES).optional() });

/** The resend key of a recommendation's report: one per signature, so a second Approve files nothing. */
const keyOf = (signature: string): string => `review-${signature}`;

export const COMPLETION_REVIEW_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/:id/completion-review', tag: 'Jobs', summary: 'An ended job\'s completion review', description: 'Issue #2846: the review the hopper made of the job\'s run after it ended, from its events, its token ledger and its work item\'s jobs; rules only. `review.modelReview`, when the model review is on (issue #2846 part 3): the model\'s own review beside it — `summary`, `went`, `stalls`, `suggestions`, `hopperDefect` (why the model thinks the run hit a hopper defect), `model`, `costUsd`, `at` —; `review.modelFailed` (`error`, `at`): the model failed, and is not asked again. `recommendation`: the bug-report recommendation of the hopper defect its review found (`review.defect`), as GET /api/completion-review/recommendations lists it. `review` absent: the job did not end, ended less than a minute ago, or the settings (`GET /api/completion-review`) skip it. `outcome` (`finished`, `failed`, `cancelled`); `durationMs` from its creation to its end; `stages`, the time in each stage, longest first (`queued`: waiting for a lane; `running`; `person`: a question, or its own wait on an approval, a grant or an infra plan; `waiting`: its own wait on anything else; `parked`); `jobs`, the jobs of its work item; `questions`; `went`, what went well, and `stalls`, where it lost time, in plain words; `restarts` (`requeued`, `preempted`, `parked` by the hopper, `link_lost`, `oom_killed`, `heap_retry`), each with its `count` and first `causes`; `waste`, its waste signals (as on `GET /api/jobs/:id/tokens`); `suggestions`, the changes that would have helped, each with its `area` (`config`, `routing`, `lane`, `template`, `prompt`) and `text`. 404: no such job.', returns: '`{ review?: CompletionReview, recommendation?: BugReportRecommendation }`', errors: [404] },
  { method: 'get', path: '/api/completion-review/recommendations', tag: 'Jobs', summary: 'The bug-report recommendations of the completion reviews', description: 'Issue #2846 part 2: one per hopper defect a completion review found, by its `signature` (`cause:<cause id>`: the sweep stopped a job at work, or its session lost its way to the hopper; `requeue-loop`, with its first cause: the hopper queued one job again 3 times or more), newest first (at most 200): its `title` and `description`, the report it would file; `jobId`, the job whose review found it first, and `jobs`, how many reviewed jobs found it; `state` — `open`: it waits for a person, `approved`: it went to Report a bug (`reportId`), `dismissed` (`reason`) —, `by` and `decidedAt`. `state` in the query lists only those. Not cached.', returns: '`{ recommendations: BugReportRecommendation[] }`', errors: [400] },
  { method: 'post', path: '/ui/api/completion-review/recommendations/approve', tag: 'Jobs', summary: 'Approve a bug-report recommendation', description: 'Issue #2846 part 2: the recommendation goes to Report a bug as a report of the job whose review found it — its private work removed, scrubbed of identifiers and masked, as a job\'s own report (issues #2812, #2818) —, with the resend key of its signature (issue #2813), and is sent at once as Approve on a job\'s report sends it: a new issue on the hopper\'s repository, through the person\'s own connection, or kept to send later. `completion_review.recommendation_decided` (`approved`). 409 while public bug reports are off (issue #2818) or when it waits no more, 404 when there is none, 502 when GitHub refused it (it stays open).', role: 'operator', body: recommendationBody, returns: 'as POST /ui/api/bug-reports/approve', errors: [404, 409, 502] },
  { method: 'post', path: '/ui/api/completion-review/recommendations/dismiss', tag: 'Jobs', summary: 'Dismiss a bug-report recommendation', description: 'Issue #2846 part 2: the recommendation is not filed, and its `reason` (at most 500 characters) is kept; a review that finds the same signature later recommends nothing. `completion_review.recommendation_decided` (`dismissed`). 409 when it waits no more, 404 when there is none.', role: 'operator', body: dismissRecommendationBody, returns: '`BugReportRecommendation`', errors: [404, 409] },
  { method: 'get', path: '/api/completion-review', tag: 'Jobs', summary: 'Which ended jobs get a completion review', description: 'Issue #2846: `on` (default on); `outcomes`, the ends reviewed (`finished`, `failed`, `cancelled`; default `failed`); `multiJob`, a job of a work item that had more than one job is reviewed whatever its end (default on); `minRunMinutes`, a job that ran less than this on its first run is trivial and skipped (default 5); `modelReview` (issue #2846 part 3), the model review beside the rule review: `on` (default off), `model`, the model the `claude` CLI runs (default `haiku`), and `dailyCostUsd`, the daily cost cap (default 1): no model review is asked while the model reviews of the last day cost this or more.', returns: '`CompletionReviewSettings`' },
  { method: 'post', path: '/ui/api/completion-review', tag: 'Jobs', summary: 'Change which ended jobs get a completion review', description: 'Any of the parts; one left out keeps its value, and so does each part of `modelReview` (`completion_review.settings_changed`). `minRunMinutes` from 0 to a day; `modelReview.dailyCostUsd` from 0 to 100. Applies from the next pass, without a restart; a review already kept stays.', role: 'admin', body: completionReviewBody, returns: '`CompletionReviewSettings`', errors: [400] },
];

export const completionReviewView = (t: Pick<TenantParts, 'store'>): CompletionReviewSettings => completionReviewSettingsOf(t.store.settings.getCompletionReview());

export function registerCompletionReviewRoutes(app: FastifyInstance, o: { admin: Guard; operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/completion-review', async (req) => completionReviewView(o.tenant(req)));
  app.get('/api/jobs/:id/completion-review', async (req): Promise<{ review?: CompletionReview; recommendation?: BugReportRecommendation }> => {
    const { id } = parseWith(z.object({ id: z.string() }), req.params);
    const { store } = o.tenant(req);
    if (!store.jobs.get(id)) throw new HttpError(404, `job ${id} not found`);
    const review = store.completionReviews.get(id);
    const recommendation = review?.defect ? store.reviewRecommendations.get(review.defect.signature) : undefined;
    return review ? { review, ...(recommendation ? { recommendation } : {}) } : {};
  });
  app.get('/api/completion-review/recommendations', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { state } = parseWith(recommendationQuery, req.query);
    return { recommendations: o.tenant(req).store.reviewRecommendations.list(state) };
  });
  /** The open recommendation of the body's signature: else 404, or 409 when it waits no more. */
  const open = (t: TenantParts, signature: string): BugReportRecommendation => {
    const r = t.store.reviewRecommendations.get(signature);
    if (!r) throw new HttpError(404, `recommendation ${signature} not found`);
    if (r.state !== 'open') throw new HttpError(409, `this recommendation is ${r.state}`);
    return r;
  };
  app.post('/ui/api/completion-review/recommendations/approve', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to approve a recommendation');
    const t = o.tenant(req);
    const r = open(t, parseWith(recommendationBody, req.body).signature);
    const reports = bugReportsOf(t, (line) => req.log.warn(line));
    try {
      const held = await reports.fileForJob(r.jobId, { title: r.title, body: r.description, key: keyOf(r.signature) });
      const answer = held.kind === 'approval' ? await reports.approve(held.id) : held;
      const reportId = keyedReportId(`job ${r.jobId}`, keyOf(r.signature));
      t.store.tx(() => {
        t.store.reviewRecommendations.decide(r.signature, { state: 'approved', at: new Date().toISOString(), by: personOf(s), reportId });
        t.store.events.append({ type: 'completion_review.recommendation_decided', jobId: r.jobId, data: { signature: r.signature, state: 'approved', by: personOf(s), reportId } });
      });
      return answer;
    } catch (e) {
      if (e instanceof BugReportRefused) throw new HttpError(e.status, e.message);
      throw e;
    }
  });
  app.post('/ui/api/completion-review/recommendations/dismiss', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to dismiss a recommendation');
    const t = o.tenant(req);
    const { signature, reason } = parseWith(dismissRecommendationBody, req.body);
    const r = open(t, signature);
    return t.store.tx(() => {
      const decided = t.store.reviewRecommendations.decide(r.signature, { state: 'dismissed', at: new Date().toISOString(), by: personOf(s), reason });
      t.store.events.append({ type: 'completion_review.recommendation_decided', jobId: r.jobId, data: { signature: r.signature, state: 'dismissed', by: personOf(s), reason } });
      return decided;
    });
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
        modelReview: {
          on: patch.modelReview?.on ?? from.modelReview.on, model: patch.modelReview?.model ?? from.modelReview.model,
          dailyCostUsd: patch.modelReview?.dailyCostUsd ?? from.modelReview.dailyCostUsd,
        },
      };
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setCompletionReview(to);
      t.store.events.append({ type: 'completion_review.settings_changed', data: { from, to, by: personOf(s) } });
    });
    return completionReviewView(t);
  });
}
