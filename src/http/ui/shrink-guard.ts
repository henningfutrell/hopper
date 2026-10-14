// Settings → Shrink guard (issue #1096, design.md "The shrink guard"): the percent of a file's lines a job's push that
// brings in its base branch may take before the hopper refuses it. Emptied or removed is refused at any percent; a file the
// branch's own change empties or shrinks never is. Read at each push, so a change applies without a restart. Least role
// to change: admin.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_SHRINK_GUARD, SHRINK_GUARD_PERCENT, type ShrinkGuardSettings } from '../../domain/types.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const shrinkGuardBody = z.strictObject({ percent: z.number().int().min(SHRINK_GUARD_PERCENT.min).max(SHRINK_GUARD_PERCENT.max) });

const settingsOf = (t: Pick<TenantParts, 'store'>): ShrinkGuardSettings => t.store.settings.getShrinkGuard() ?? DEFAULT_SHRINK_GUARD;

export const SHRINK_GUARD_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/shrink-guard', tag: 'Jobs', summary: 'Shrink guard', description: 'Issue #1096: a job\'s push that brings in its base branch (a rebase, or a merge of the base, as a tend job\'s conflict resolution makes) is refused when it takes more than `percent` of a file\'s lines, or empties or removes it, and the branch\'s own change did not. `percent`: 50, the default.', returns: '`{ percent: number }`' },
  { method: 'post', path: '/ui/api/shrink-guard', tag: 'Jobs', summary: 'Set the shrink guard\'s percent', description: `Recorded as \`shrink_guard.changed\` when it changes. \`percent\`: ${SHRINK_GUARD_PERCENT.min}–${SHRINK_GUARD_PERCENT.max}; at 100 only a file emptied or removed is refused. Applies to the next push, without a restart.`, role: 'admin', body: shrinkGuardBody, returns: '`{ percent: number }`', errors: [400] },
];

export function registerShrinkGuardRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/shrink-guard', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/shrink-guard', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the shrink guard');
    const t = o.tenant(req);
    const to = parseWith(shrinkGuardBody, req.body);
    t.store.tx(() => {
      const from = settingsOf(t);
      if (from.percent === to.percent) return;
      t.store.settings.setShrinkGuard(to);
      t.store.events.append({ type: 'shrink_guard.changed', data: { from, to, by: identityName(s.identity) } });
    });
    return settingsOf(t);
  });
}
