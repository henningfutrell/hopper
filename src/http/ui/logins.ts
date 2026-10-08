// The UI session's actions on a login (issue #476): cancel it, ask its run for a new code (operator), and what a
// job does when its login expires (admin). The logins answer them; a herdr job is told in its pane.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOGIN_EXPIRY_ACTIONS } from '../../domain/types.ts';
import type { LoginAction } from '../../logins/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const idParams = z.object({ id: z.string() });
export const loginSettingsBody = z.strictObject({ onExpiry: z.enum(LOGIN_EXPIRY_ACTIONS) });

const STATUS = { not_found: 404, ended: 409, not_renewable: 409 } as const;

export function registerLoginRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  const answer = (r: LoginAction) => {
    if (r.ok) return r.login;
    throw new HttpError(STATUS[r.reason], r.message);
  };
  app.post('/ui/api/logins/:id/cancel', o.operator, async (req) => answer(o.tenant(req).logins.cancel(parseWith(idParams, req.params).id)));
  app.post('/ui/api/logins/:id/new-code', o.operator, async (req) => answer(o.tenant(req).logins.newCode(parseWith(idParams, req.params).id)));
  // Read at each expiry: applies without a restart (issue #356).
  app.post('/ui/api/logins/settings', o.admin, async (req) => {
    const { onExpiry } = parseWith(loginSettingsBody, req.body);
    const t = o.tenant(req);
    t.store.settings.setLoginExpiry(onExpiry);
    return t.logins.settings();
  });
}
