// File an issue (issue #471, design.md "File an issue"): whether it can run now; a job's context, masked, to attach; the
// prompt the file-issue run skill would be sent, exactly; the draft by the person's own signed-in Claude, cancelled when the
// request is closed; the confirm step on the text as the person edited it; and the issue filed only once they confirmed
// it, with their own GitHub connection, on one of their job repositories, with no label and no assignee. Least role:
// operator, so a viewer is refused here, whatever the UI shows. Not a box action: it starts no job and acts on no machine.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ISSUE_BODY_MAX, ISSUE_CONTEXT_MAX, ISSUE_TEXT_MAX, ISSUE_TITLE_MAX } from '../../domain/issue-drafts.ts';
import { RESEND_KEY } from '../../domain/post-key.ts';
import { IssueDraftRefused } from '../../issue-drafts/index.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };
const repo = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
const title = z.string().trim().min(1, 'give the issue a title').max(ISSUE_TITLE_MAX);
const body = z.string().trim().min(1, 'say what the issue is').max(ISSUE_BODY_MAX);

export const issueContextBody = z.strictObject({ jobId: z.string().min(1).max(200) });
export const issueDraftBody = z.strictObject({
  repo,
  text: z.string().trim().min(1, 'say what the issue is about').max(ISSUE_TEXT_MAX),
  context: z.string().max(ISSUE_CONTEXT_MAX).optional(),
  instructions: z.string().max(ISSUE_TEXT_MAX).optional(),
  previous: z.strictObject({ title: z.string().max(ISSUE_TITLE_MAX), body: z.string().max(ISSUE_BODY_MAX) }).optional(),
});
export const issueCheckBody = z.strictObject({ repo, title, body, allowPersonalData: z.boolean().optional() });
export const issueFileBody = z.strictObject({
  repo, title, body,
  confirmed: z.literal(true, 'confirm the issue first: nothing is filed without your confirmation'),
  confirmPublic: z.boolean().optional(),
  allowPersonalData: z.boolean().optional(),
  jobId: z.string().min(1).max(200).optional(),
  key: z.string().regex(RESEND_KEY, 'a resend key: 8 to 64 letters, digits, _ or -').optional(),
});

const DRAFT = '`DraftAnswer`: `repo`, `title`, `body` (secrets and personal data masked), `notes` (what the skill changed or left out; never filed), `findings` (the draft constraints the draft as written broke: `constraint`, `what`), `provider`, `model`, `skill` (`file-issue@<id>`)';

export const ISSUE_DRAFT_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/issue-drafts', tag: 'Jobs', summary: 'Whether File an issue can run', description: 'Issue #471: the `provider` that drafts (the user\'s own `claude` CLI, signed in to their Claude account), whether it is `available`, whether the whole flow is `usable` now (a provider, a GitHub connection and a job repository), the `reason` when it is not, and the `repos` an issue may be filed on: the user\'s job repositories. Changes nothing. Not cached.', returns: '`{ provider, available, usable, reason?, repos }`' },
  { method: 'post', path: '/ui/api/issue-drafts/context', tag: 'Jobs', summary: 'A job as the context of an issue', description: 'Issue #471: what File an issue attaches of a job, for the person to read and edit before it is sent: its id and state, its item\'s title and link, its error and its last 20 log lines. Masked: secrets, the host name, email addresses, phone numbers, IP addresses, private host names and home directories. Changes nothing.', role: 'operator', body: issueContextBody, returns: '`{ context }`', errors: [404] },
  { method: 'post', path: '/ui/api/issue-drafts/prompt', tag: 'Jobs', summary: 'What a draft would send', description: 'Issue #471: the prompt the file-issue run skill (issue #472) would be sent for this request, exactly: its instructions, its constraints, its login section, its template, the person\'s `text`, and the `context` with, on a run again, the `previous` draft and the `instructions`. `repo` must be one of the user\'s job repositories (400). Changes nothing.', role: 'operator', body: issueDraftBody, returns: '`{ prompt }`', errors: [400] },
  { method: 'post', path: '/ui/api/issue-drafts/draft', tag: 'Jobs', summary: 'Draft an issue', description: `Issue #471: runs the file-issue run skill (issue #472) with the user's own signed-in Claude — print mode, no tools, no MCP, no settings, no session — and answers the draft, cleaned. Closing the request cancels it. Files nothing. \`repo\` not a job repository: 400; no provider: 409; no draft in time: 504; the provider's error: 502. The person's text stays with the UI. \`issue_draft.drafted\`, never the text.`, role: 'operator', body: issueDraftBody, returns: DRAFT, errors: [400, 409, 502, 504] },
  { method: 'post', path: '/ui/api/issue-drafts/check', tag: 'Jobs', summary: 'The confirm step of an issue', description: 'Issue #471: what filing would do, on the text as the person edited it: the `repo` and its `visibility`, the `title`, the `body` as filed (with the note that it was drafted with Claude), the `labels` and `assignees` (always none), the draft constraints the text breaks (`findings`), and the `refusal` when it cannot be filed so. With the person\'s own GitHub connection (409 without one). Changes nothing.', role: 'operator', body: issueCheckBody, returns: '`IssueCheck`', errors: [400, 409, 502] },
  { method: 'post', path: '/ui/api/issue-drafts', tag: 'Jobs', summary: 'File an issue', description: 'Issue #471: files the issue the person confirmed (`confirmed: true`, else 400), with their own GitHub connection — the account of the repository —, on one of their job repositories (400), with no label and no assignee, so it never starts a job. The draft constraints run again on this text: a secret, an @ mention or a title or body too long is refused (422), personal data on a public repository, or on another without `allowPersonalData` (422); a public repository needs `confirmPublic` (409). GitHub\'s refusal is 502. The body ends with its post key, a hidden line (issue #2813): `key`, the resend key the dialog made (8 to 64 letters, digits, `_` or `-`), else one made for it; the same person\'s key sent again while the hopper runs is answered the first issue, and nothing is filed twice. `issue_draft.filed` (`repo`, `number`, `url`, `by`, `provider`, `skill`), on the timeline of the attached `jobId`, never the text.', role: 'operator', body: issueFileBody, returns: '`{ repo, number, url }`', errors: [400, 409, 422, 502] },
];

/** `fn`'s answer; a refusal as the HTTP error it names. */
const answer = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof IssueDraftRefused) throw new HttpError(e.status, e.message);
    throw e;
  }
};

/** The status read (issue #471), beside the other `/api/` reads. */
export function issueDraftReadRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/issue-drafts', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return o.tenant(req).githubProxy.issueDrafts.status();
  });
}

export function registerIssueDraftRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const drafts = (req: FastifyRequest) => o.tenant(req).githubProxy.issueDrafts;
  app.post('/ui/api/issue-drafts/context', o.operator, async (req) => {
    const { jobId } = parseWith(issueContextBody, req.body);
    return { context: await answer(() => drafts(req).context(jobId)) };
  });
  app.post('/ui/api/issue-drafts/prompt', o.operator, async (req) => {
    const r = parseWith(issueDraftBody, req.body);
    return { prompt: await answer(() => drafts(req).prompt(r)) };
  });
  app.post('/ui/api/issue-drafts/draft', o.operator, async (req, reply) => {
    const r = parseWith(issueDraftBody, req.body);
    // The person's Cancel closes the request: the run ends with it.
    const cancel = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) cancel.abort(); };
    reply.raw.on('close', onClose);
    try {
      return await answer(() => drafts(req).draft(r, cancel.signal));
    } finally {
      reply.raw.off('close', onClose);
    }
  });
  app.post('/ui/api/issue-drafts/check', o.operator, async (req) => {
    const r = parseWith(issueCheckBody, req.body);
    return answer(() => drafts(req).check(r));
  });
  app.post('/ui/api/issue-drafts', o.operator, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to file an issue');
    const r = parseWith(issueFileBody, req.body);
    return answer(() => drafts(req).file(r, personOf(s)));
  });
}
