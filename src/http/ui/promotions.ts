// Promote to GitHub (issue #946, design.md "Promote to GitHub"): a finished direct job's preview, which changes nothing;
// the promotion the person confirmed, posted with their own GitHub connection; and a revoke, which leaves GitHub as it
// is. Least role: operator. Not a box action: it starts no job and acts on no machine.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PromotionRefused } from '../../promotions/service.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const idParams = z.object({ id: z.string() });
const repo = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
const target = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('issue') }), z.strictObject({ kind: z.literal('comment'), number: z.number().int().min(1) })]);

export const promotionPreviewBody = z.strictObject({ repo: repo.optional(), target: target.optional(), includeRequester: z.boolean().optional() });
export const promotionBody = z.strictObject({
  repo, target,
  title: z.string().trim().min(1, 'give it a title').max(256),
  body: z.string().trim().min(1, 'say what to post').max(60_000),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  artifacts: z.array(z.string().min(1).max(200)).max(50).default([]),
  commit: z.array(z.string().min(1).max(200)).max(50).optional(),
  includeRequester: z.boolean().optional(),
  confirmPublic: z.boolean().optional(),
  allowPersonalData: z.boolean().optional(),
});

const PROMOTION = '`Promotion`: `id`, `directJobId`, `repo`, `kind` (`issue` or `comment`), `number`, `url`, `commentId`, `artifacts` (`id`, `title`, `revision` as linked, and `committed`: `branch`, `path`, `url` when it was committed), `promotedBy`, `promotedAt`, `updatedAt`';

export const PROMOTION_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/direct-jobs/:id/promotion/preview', tag: 'Jobs', summary: 'Preview a promotion to GitHub', description: 'Issue #946: what promoting the direct job would post, for the person to edit and confirm — the `repo` (the one asked, else the live promotion\'s, else the direct job\'s) and its `visibility`, the `target` (a new issue, or a `comment` on issue `number`), the `title`, the `body` (the brief and the results, with secrets and personal data masked), the routing `labels` (never the hopper\'s own), the job\'s `artifacts` (each linked; `commit` names the branch and path it would be committed to when ticked, or `no` and why it is linked only), the `footer` as it would be posted (the links are made only on the hopper\'s public URL and need a hopper sign-in; who promoted it; the requester only with `includeRequester`), the live promotion it would `update`, the scan\'s `findings` and `notes`. Only once its job finished or failed (409), with the person\'s own GitHub connection (409 without one). Changes nothing.', role: 'operator', body: promotionPreviewBody, returns: '`PromotionDraft`', errors: [404, 409, 502] },
  { method: 'post', path: '/ui/api/direct-jobs/:id/promotion', tag: 'Jobs', summary: 'Promote a direct job to GitHub', description: 'Issue #946: posts what the person confirmed, with their own GitHub connection, never a job\'s: a new issue with the `labels` (the hopper\'s own left out), or a comment on the issue `target.number`. The `body`, then the footer: the chosen `artifacts` as links. Each artifact in `commit` (small text artifacts the person ticked, among `artifacts`) is scanned as the text is and committed to the branch `hopper-promotion/<id>`, made from the default branch, and linked there. the direct job\'s link, who promoted it, the requester with `includeRequester`. Made again while a promotion is live, it edits that issue or comment instead (409 for another repository or target: revoke first). Refused: a secret in the text (422); personal data on a public repository, or on another without `allowPersonalData` (422); a public repository without `confirmPublic` (409); an artifact not of its job, an artifact to commit that is not linked, binary or too big (400); a secret or personal data in an artifact to commit, as in the text (422). GitHub\'s refusal is 502. Posted once (issue #1591): a new issue or comment ends with a hidden post key, kept before GitHub is asked; a stop or a lost answer is linked by that key at the next promotion or start, never posted twice; while one promotion of the direct job is on its way, another is 409. `direct_job.promoted`, never the text.', role: 'operator', body: promotionBody, returns: PROMOTION, errors: [400, 404, 409, 422, 502] },
  { method: 'post', path: '/ui/api/direct-jobs/:id/promotion/revoke', tag: 'Jobs', summary: 'Revoke a promotion', description: 'Issue #946: ends the live promotion\'s link in the hopper. It unpublishes nothing: GitHub keeps the issue or the comment until a person removes it there. A later promotion posts anew. `direct_job.promotion_revoked`.', role: 'operator', body: z.strictObject({}), returns: '`{ revoked: true, note }`', errors: [404] },
];

/** `fn`'s answer; a refusal as the HTTP error it names. */
const answer = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PromotionRefused) throw new HttpError(e.status, e.message);
    throw e;
  }
};

export function registerPromotionRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const person = (req: FastifyRequest): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to promote a direct job');
    return personOf(s);
  };
  app.post('/ui/api/direct-jobs/:id/promotion/preview', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const b = parseWith(promotionPreviewBody, req.body ?? {});
    person(req);
    return answer(() => o.tenant(req).githubProxy.promotions.preview(id, {
      ...(b.repo ? { repo: b.repo } : {}), ...(b.target ? { target: b.target } : {}), ...(b.includeRequester ? { includeRequester: true } : {}),
    }));
  });
  app.post('/ui/api/direct-jobs/:id/promotion', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const b = parseWith(promotionBody, req.body);
    return answer(() => o.tenant(req).githubProxy.promotions.promote(id, b, person(req)));
  });
  app.post('/ui/api/direct-jobs/:id/promotion/revoke', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    parseWith(z.strictObject({}), req.body ?? {});
    return answer(() => o.tenant(req).githubProxy.promotions.revoke(id, person(req)));
  });
}
