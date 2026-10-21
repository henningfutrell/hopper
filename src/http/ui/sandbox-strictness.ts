// Vault, sandbox strictness (issue #655 part 8, brake 2, design.md "Trust stamps"): which sandbox runs gate 2
// may approve with no person — by default, per blast radius level and per template. Standard by default. Read at each
// ask, so a change applies at once. Least role to change: admin; a box action, since a looser brake lets runs through
// with no person.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TEMPLATE_NAME } from '../../domain/access.ts';
import { RADIUS_LEVELS } from '../../domain/blast-radius.ts';
import { DEFAULT_SANDBOX_STRICTNESS, SANDBOX_STRICTNESS, type SandboxStrictness } from '../../domain/sandbox-strictness.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { personOf } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const strictness = z.enum(SANDBOX_STRICTNESS);
export const sandboxStrictnessBody = z.strictObject({
  default: strictness,
  radius: z.strictObject(Object.fromEntries(RADIUS_LEVELS.map((l) => [l, strictness.optional()])) as Record<typeof RADIUS_LEVELS[number], z.ZodOptional<typeof strictness>>),
  templates: z.record(z.string().regex(TEMPLATE_NAME, 'a template name'), strictness).refine((r) => Object.keys(r).length <= 200, 'at most 200 templates'),
});

const settingsOf = (t: Pick<TenantParts, 'store'>): SandboxStrictness => t.store.settings.getSandboxStrictness() ?? DEFAULT_SANDBOX_STRICTNESS;

/** Keys sorted, the radius levels in their order: one setting has one form, so an unchanged save records nothing. */
const sorted = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const SHAPE = '`{ default: Strictness, radius: { low?, medium?, high?: Strictness }, templates: { [name]: Strictness } }`, Strictness `relaxed` | `standard` | `strict` | `locked`';

export const SANDBOX_STRICTNESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/sandbox-strictness', tag: 'Vault', summary: 'Sandbox strictness', description: 'Issue #655 (brake 2): which sandbox runs gate 2 may approve with no person. `relaxed` and `standard` (the default): the sandbox approval toggles and policies decide; `strict`: a person approves each run of a medium or high blast radius template, or one with no rating; `locked`: a person approves each run. A template\'s own line wins over its radius level, and that over `default`. It covers sandbox requests, need steps and the standing read grant.', returns: SHAPE },
  { method: 'post', path: '/ui/api/sandbox-strictness', tag: 'Vault', summary: 'Set sandbox strictness', description: 'Issue #655: the whole setting. Recorded as `sandbox.strictness_changed` when it changes. Applies at once: a run approved before with no person no longer counts where it now asks a person; a run a person approved still does. A box action: a looser brake lets runs through with no person.', role: 'admin', body: sandboxStrictnessBody, returns: SHAPE, errors: [400] },
];

export function registerSandboxStrictnessRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/sandbox-strictness', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/sandbox-strictness', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the sandbox strictness');
    const t = o.tenant(req);
    const body = parseWith(sandboxStrictnessBody, req.body);
    const radius = Object.fromEntries(RADIUS_LEVELS.flatMap((l) => (body.radius[l] ? [[l, body.radius[l]]] : [])));
    const to: SandboxStrictness = { default: body.default, radius, templates: sorted(body.templates) };
    t.store.tx(() => {
      const from = settingsOf(t);
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setSandboxStrictness(to);
      t.store.events.append({ type: 'sandbox.strictness_changed', data: { from, to, by: personOf(s) } });
    });
    return settingsOf(t);
  });
}
