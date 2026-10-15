// Header badges (issue #1181, design.md "Header badges"): which of the Dashboard's KPI cards show their total in the
// header. The session's user's own choice, a viewer's too, kept in the user's settings: one Lanes badge until chosen.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_HEADER_BADGES, HEADER_BADGES, inCardOrder, type HeaderBadgeSettings } from '../../domain/header-badges.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import type { TenantParts } from '../tenants.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const headerBadgesBody = z.strictObject({ badges: z.array(z.enum(HEADER_BADGES)).max(HEADER_BADGES.length * 2) });

const settingsOf = (t: Pick<TenantParts, 'store'>): HeaderBadgeSettings => t.store.settings.getHeaderBadges() ?? DEFAULT_HEADER_BADGES;

/** The header badges' part of the API reference (src/http/openapi.ts). */
export const HEADER_BADGE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/header-badges', tag: 'Machines and usage', summary: 'Header badges', description: `Issue #1181: the Dashboard's KPI cards whose totals the header shows, in the cards' order: ${HEADER_BADGES.join(', ')}. Each badge reads its card's own total. \`['lanes']\` until the user chooses.`, returns: '`{ badges: HeaderBadge[] }`' },
  { method: 'post', path: '/ui/api/header-badges', tag: 'Machines and usage', summary: 'Choose the header badges', description: 'The session\'s user\'s own choice, kept in their settings. Kept in the cards\' order, each once; `[]`: no badge.', role: 'viewer', body: headerBadgesBody, returns: '`{ badges: HeaderBadge[] }`', errors: [400] },
];

export function registerHeaderBadgeRoutes(app: FastifyInstance, o: { viewer: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/header-badges', async (req) => settingsOf(o.tenant(req)));
  app.post('/ui/api/header-badges', o.viewer, async (req) => {
    const { badges } = parseWith(headerBadgesBody, req.body);
    const t = o.tenant(req);
    t.store.settings.setHeaderBadges({ badges: inCardOrder(badges) });
    return settingsOf(t);
  });
}
