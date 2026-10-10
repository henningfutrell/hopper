// The UI session's actions on artifacts (issue #624, design.md "Artifacts"): share one of the user's artifacts with
// another user or as a public link, revoke a share, remove an artifact (operator); Settings → Artifacts — the limits,
// the retention, and whether public links work (admin). Who acts is the session's sign-in.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isRefusal, LINK_PATH, type Refusal } from '../../artifacts/index.ts';
import { ARTIFACT_LIMITS, type ArtifactSettings } from '../../domain/artifacts.ts';
import type { ArtifactEdge } from '../artifacts.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, userIdOf, type TenantParts, type Tenants } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const params = z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) });
const shareParams = params.extend({ share: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) });
/** With a user of the hopper, by name; or a public link, for `hours` (the user's default when left out). */
export const artifactShareBody = z.union([
  z.strictObject({ user: z.string().trim().min(1).max(64) }),
  z.strictObject({ link: z.literal(true), hours: z.number().int().min(1).max(ARTIFACT_LIMITS.linkHours).optional() }),
]);
const MB = 1024 * 1024;
/** Any part; one left out keeps its value. Sizes in bytes. */
export const artifactSettingsBody = z.strictObject({
  maxBytes: z.number().int().min(1024).max(ARTIFACT_LIMITS.maxBytes).optional(),
  userBytes: z.number().int().min(MB).max(ARTIFACT_LIMITS.userBytes).optional(),
  retentionDays: z.number().int().min(1).max(ARTIFACT_LIMITS.retentionDays).optional(),
  publicLinks: z.boolean().optional(),
  linkHours: z.number().int().min(1).max(ARTIFACT_LIMITS.linkHours).optional(),
  linkHoursMax: z.number().int().min(1).max(ARTIFACT_LIMITS.linkHours).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'name a setting' });

const refused = (r: Refusal): never => { throw new HttpError(r.status, r.no); };

export function registerArtifactRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts; tenants: Tenants; edge: ArtifactEdge }): void {
  const by = (req: FastifyRequest): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change artifacts');
    return identityName(s.identity);
  };
  const viewOf = (req: FastifyRequest, t: TenantParts, id: string) => {
    const a = t.artifacts.get(id);
    if (!a) throw new HttpError(404, `no artifact ${id}`);
    return o.edge.view(t, a, userIdOf(req)!);
  };

  app.post('/ui/api/artifacts/settings', o.admin, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const patch = parseWith(artifactSettingsBody, req.body);
    const next: ArtifactSettings = { ...t.artifacts.settings(), ...patch };
    if (next.linkHours > next.linkHoursMax) throw new HttpError(400, `a link's default hours (${next.linkHours}) may not pass its most (${next.linkHoursMax})`);
    if (next.maxBytes > next.userBytes) throw new HttpError(400, 'one artifact may not be larger than all of a user\'s together');
    return { settings: t.artifacts.setSettings(next, who) };
  });

  app.post('/ui/api/artifacts/:id/share', o.operator, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id } = parseWith(params, req.params);
    const body = parseWith(artifactShareBody, req.body);
    let made;
    if ('user' in body) {
      const user = o.tenants.list().find((u) => u.name === body.user);
      if (!user) throw new HttpError(404, `this hopper has no user ${body.user}`);
      made = t.artifacts.share(id, { user: { id: user.id, name: user.name } }, who);
    } else {
      made = t.artifacts.share(id, { link: true, ...(body.hours !== undefined ? { hours: body.hours } : {}) }, who);
    }
    if (isRefusal(made)) return refused(made);
    // The link is said once, here: only its hash is kept.
    return { artifact: viewOf(req, t, id), share: made.share, ...(made.token ? { link: `${o.edge.base()}${LINK_PATH}/${made.token}` } : {}) };
  });

  app.post('/ui/api/artifacts/:id/shares/:share/revoke', o.operator, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id, share } = parseWith(shareParams, req.params);
    const r = t.artifacts.revoke(id, share, who);
    if (isRefusal(r)) return refused(r);
    return { artifact: viewOf(req, t, id) };
  });

  app.post('/ui/api/artifacts/:id/remove', o.operator, async (req) => {
    const who = by(req);
    const { id } = parseWith(params, req.params);
    const r = o.tenant(req).artifacts.remove(id, who);
    if (isRefusal(r)) return refused(r);
    return { removed: r.id };
  });
}
