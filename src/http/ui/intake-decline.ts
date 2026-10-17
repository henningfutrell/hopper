// Settings → Intake, Decline (issue #1710, design.md "Decline"): the choice the Decline confirm step offers first — close
// the issue as not planned, or leave it open without the source's label —, for a request card and for a reopened card.
// Leave open and Close by default. An API decline with no choice takes it too. Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DECLINE_CHOICES, DEFAULT_INTAKE_DECLINE, type IntakeDeclineDefaults } from '../../domain/intake-decline.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const intakeDeclineBody = z.strictObject({ request: z.enum(DECLINE_CHOICES), reopened: z.enum(DECLINE_CHOICES) });

const settingsOf = (t: Pick<TenantParts, 'store'>): IntakeDeclineDefaults => t.store.settings.getIntakeDecline() ?? DEFAULT_INTAKE_DECLINE;

export const INTAKE_DECLINE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/intake-decline', tag: 'Jobs', summary: 'Decline defaults', description: 'Issue #1710: the choice the Decline confirm step offers first, and what a `decline` with no `choice` does. `request`: for a request card, `open` by default. `reopened`: for a reopened card, `close` by default. `close` closes the issue as not planned and takes off the source\'s label, its priority labels and `hopper:done`; `open` leaves it open and takes off the source\'s label. Either way the hopper posts one comment that says what it did.', returns: '`{ request: "close" | "open", reopened: "close" | "open" }`' },
  { method: 'post', path: '/ui/api/intake-decline', tag: 'Jobs', summary: 'Set the decline defaults', description: 'Issue #1710: the whole setting. Recorded as `intake.decline_changed` when it changes.', role: 'admin', body: intakeDeclineBody, returns: '`{ request: "close" | "open", reopened: "close" | "open" }`', errors: [400] },
];

export function registerIntakeDeclineRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/intake-decline', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/intake-decline', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the decline defaults');
    const t = o.tenant(req);
    const to = parseWith(intakeDeclineBody, req.body);
    t.store.tx(() => {
      const from = settingsOf(t);
      if (from.request === to.request && from.reopened === to.reopened) return;
      t.store.settings.setIntakeDecline(to);
      t.store.events.append({ type: 'intake.decline_changed', data: { from, to, by: personOf(s) } });
    });
    return settingsOf(t);
  });
}
