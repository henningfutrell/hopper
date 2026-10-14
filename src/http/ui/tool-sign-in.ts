// Tool sign-in (issue #1128, design.md "Tool sign-in"): start the sign-in of a machine's agent tool from Accounts, and give it the
// code its sign-in page showed. Both answer the login as any route does: its URL only from `GET /api/logins` to a UI session of
// the user (src/http/logins.ts), never here. Operator, as the other login actions; box actions (they change work on a machine).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SignInPaste, SignInStart } from '../../logins/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { Operation } from '../openapi-operation.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const toolSignInBody = z.strictObject({
  source: z.string().min(1).describe('the usage source that reads the tool on the machine (`ToolAccountMachine.source`)'),
  email: z.string().email().optional().describe('the account to pre-fill on the sign-in page'),
});
export const loginCodeBody = z.strictObject({ code: z.string().min(1).max(512).describe('the code the sign-in page showed') });
const idParams = z.object({ id: z.string() });

/** Their operations in the API reference. */
export const TOOL_SIGN_IN_OPERATIONS: Operation[] = [
  { method: 'post', path: '/ui/api/tool-accounts/sign-in', tag: 'Logins', summary: 'Sign a machine\'s agent tool in', description: 'Issue #1128: the usage source `source` (a machine of `GET /api/tool-accounts`, `signIn: true`) starts its tool\'s sign-in on its machine (`claude auth login`, through its client, ssh or container), and the hopper opens a login of kind `paste_code` on that machine, with no job (`run` `sign-in`). Open its URL (`GET /api/logins/:id`, a UI session of the user only), sign in, then send the code the page shows to `POST /ui/api/logins/:id/code`. A new sign-in on the same machine cancels the one before. It waits 15 minutes for its code. 409: the source cannot sign in. 502: the sign-in did not start (the machine is offline, the tool printed no URL).', role: 'operator', body: toolSignInBody, returns: 'the `LoginView`, without its URL', errors: [400, 404, 409, 502] },
  { method: 'post', path: '/ui/api/logins/:id/code', tag: 'Logins', summary: 'Give a sign-in its code', description: 'Issue #1128: the code the sign-in page showed goes to the tool waiting on the `paste_code` login, and the answer comes once the tool ended: the login `completed` (`auth.completed`), and the usage source reads the account again at once; or `failed` with the tool\'s reason (`auth.failed`). The code is never kept, logged or in an event. 400: no code. 409: the login is not a sign-in that waits for its code.', role: 'operator', body: loginCodeBody, returns: 'the `LoginView`', errors: [400, 404, 409] },
];

const STATUS = { not_found: 404, no_sign_in: 409, not_started: 502, ended: 409, not_renewable: 409, bad_code: 400 } as const;

export function registerToolSignInRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const answer = (t: TenantParts, r: SignInStart | SignInPaste) => {
    if (r.ok) return t.logins.view(r.login, false);
    throw new HttpError(STATUS[r.reason], r.message);
  };
  app.post('/ui/api/tool-accounts/sign-in', o.operator, async (req) => {
    const { source, email } = parseWith(toolSignInBody, req.body);
    const t = o.tenant(req);
    return answer(t, await t.signIns.start(source, email ? { email } : {}));
  });
  app.post('/ui/api/logins/:id/code', o.operator, async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { code } = parseWith(loginCodeBody, req.body);
    const t = o.tenant(req);
    return answer(t, await t.signIns.paste(id, code));
  });
}
