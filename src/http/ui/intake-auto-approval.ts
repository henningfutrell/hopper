// Settings → Intake, auto-approval (issue #1268, design.md "Auto-approval"): whether the hopper approves the request cards
// a rule matches — reopened by, written by, or labelled `hopper:high` by a trusted actor, or written by a listed app — and
// the apps and bots trusted to act for the user. On by default. Read at each sync, so a change applies at the next one.
// Least role to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APP_SLUG, appSlug, DEFAULT_INTAKE_AUTO_APPROVAL, type IntakeAutoApproval } from '../../domain/intake-auto-approve.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const app = z.string().transform(appSlug).pipe(z.string().regex(APP_SLUG, 'an app\'s slug: letters, digits and hyphens, with or without [bot]'));
export const intakeAutoApprovalBody = z.strictObject({ on: z.boolean(), apps: z.array(app).max(50) });

const settingsOf = (t: Pick<TenantParts, 'store'>): IntakeAutoApproval => t.store.settings.getIntakeAutoApproval() ?? DEFAULT_INTAKE_AUTO_APPROVAL;

export const INTAKE_AUTO_APPROVAL_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/intake-auto-approval', tag: 'Jobs', summary: 'Auto-approval', description: 'Issue #1268: whether the hopper approves a request card itself, recorded as `source.request_auto_approved`, when a trusted actor or a listed app reopened it after its job was done, a trusted actor wrote it, a listed app wrote it, or a trusted actor or a listed app added `hopper:high`. A card a job filed, whose text changed since a person approved it, that someone else edited, or whose trusted actors cannot be checked, waits for a person. `on`: true, the default. `apps`: the apps and bots trusted to act for the user, by slug.', returns: '`{ on: boolean, apps: string[] }`' },
  { method: 'post', path: '/ui/api/intake-auto-approval', tag: 'Jobs', summary: 'Set auto-approval', description: 'Issue #1268: the whole setting. Each app is kept by its slug, lowercased, with no `[bot]`. Recorded as `intake.auto_approval_changed` when it changes. Applies from the next sync.', role: 'admin', body: intakeAutoApprovalBody, returns: '`{ on: boolean, apps: string[] }`', errors: [400] },
];

export function registerIntakeAutoApprovalRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/intake-auto-approval', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/intake-auto-approval', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change auto-approval');
    const t = o.tenant(req);
    const body = parseWith(intakeAutoApprovalBody, req.body);
    const to: IntakeAutoApproval = { on: body.on, apps: [...new Set(body.apps)].sort() };
    t.store.tx(() => {
      const from = settingsOf(t);
      if (from.on === to.on && from.apps.join() === to.apps.join()) return;
      t.store.settings.setIntakeAutoApproval(to);
      t.store.events.append({ type: 'intake.auto_approval_changed', data: { from, to, by: personOf(s) } });
    });
    return settingsOf(t);
  });
}
