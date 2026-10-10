// The TL;DR setting (issue #569, design.md "TL;DR"): whether a cheap model writes a TL;DR for every long card, and the
// cards show it. An admin's; read on every sweep and every read, so a change applies without a restart. Read at
// GET /api/tldr. Turned on, the open cards get theirs at once.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TldrSettings } from '../../domain/types.ts';
import { tldrSettings } from '../../tldr/index.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const tldrBody = z.strictObject({ enabled: z.boolean() });

export const tldrView = (t: Pick<TenantParts, 'store'>): TldrSettings => tldrSettings(t.store);

export function registerTldrRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/tldr', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change the TL;DR');
    const t = o.tenant(req);
    const to = parseWith(tldrBody, req.body);
    const changed = t.store.tx(() => {
      const from = tldrSettings(t.store);
      if (from.enabled === to.enabled) return false;
      t.store.settings.setTldr(to);
      t.store.events.append({ type: 'tldr.settings_changed', data: { from, to, by: identityName(s.identity) } });
      return true;
    });
    if (changed && to.enabled) void t.tldrs.sweep();
    return tldrView(t);
  });
}
