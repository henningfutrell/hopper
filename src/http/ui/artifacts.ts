// The UI session's actions on artifacts (issue #624, design.md "Artifacts"): share one of the user's artifacts with
// another user or as a public link, revoke a share, remove an artifact, restore an older revision as the latest, pin a
// revision so the retention sweep keeps it (operator; revisions: issue #675), revise it with a file or another
// artifact's latest content, merge artifacts into it (operator; issue #687); Settings → Artifacts — the limits,
// the retention, and whether public links work (admin). Who acts is the session's sign-in.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isRefusal, LINK_PATH, type Refusal } from '../../artifacts/index.ts';
import { ARTIFACT_LIMITS, ARTIFACT_MAX_BYTES, type ArtifactSettings } from '../../domain/artifacts.ts';
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
  /** An origin the hopper answers to, or empty for the default (issue #673). */
  linkBase: z.string().trim().max(300).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'name a setting' });

const revisionParams = params.extend({ n: z.coerce.number().int().min(1) });
export const artifactRestoreBody = z.strictObject({ revision: z.number().int().min(1) });
export const artifactPinBody = z.strictObject({ pinned: z.boolean() });
const artifactId = z.string().regex(/^[A-Za-z0-9-]{1,100}$/);
const note = z.string().max(2000).optional();
/** Issue #687: a file (its content in base64), or `from` another artifact of the user's: its latest content is copied. */
export const artifactReviseBody = z.union([
  z.strictObject({
    file: z.strictObject({ name: z.string().trim().min(1).max(500), type: z.string().trim().min(1).max(100).optional(), content: z.base64() }),
    note,
  }),
  z.strictObject({ from: artifactId, note }),
]);
/** Issue #687: the artifacts whose revisions are added to this one, in this order; each is removed after. */
export const artifactMergeBody = z.strictObject({ from: z.array(artifactId).min(1).max(50) });
/** A file's base64 is a third larger than the file: the most one artifact may hold, and room for the rest of the body. */
const REVISE_BODY_LIMIT = Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4 + 64 * 1024;

const refused = (r: Refusal): never => { throw new HttpError(r.status, r.no); };

/** A link base as kept: empty, or one of the origins the hopper answers to (else a link would be refused, 421). */
function linkBaseOf(raw: string, origins: string[]): string {
  if (raw === '') return '';
  let u: URL | undefined;
  try { u = new URL(raw); } catch { u = undefined; }
  if (!u || (u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new HttpError(400, `a link base is an origin only — scheme, host and port, no path: not ${raw}`);
  }
  if (!origins.includes(u.origin)) throw new HttpError(400, `the hopper does not answer at ${u.origin}: give one of ${origins.join(', ')}, or leave it empty`);
  return u.origin;
}

export function registerArtifactRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts; tenants: Tenants; edge: ArtifactEdge }): void {
  const by = (req: FastifyRequest): string => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change artifacts');
    return identityName(s.identity);
  };
  const viewOf = (req: FastifyRequest, t: TenantParts, id: string) => {
    const a = t.artifacts.get(id);
    if (!a) throw new HttpError(404, `no artifact ${id}`);
    return o.edge.view(t, a, userIdOf(req)!, o.edge.viewBase(req, t));
  };

  app.post('/ui/api/artifacts/settings', o.admin, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const patch = parseWith(artifactSettingsBody, req.body);
    const next: ArtifactSettings = { ...t.artifacts.settings(), ...patch };
    if (next.linkHours > next.linkHoursMax) throw new HttpError(400, `a link's default hours (${next.linkHours}) may not pass its most (${next.linkHoursMax})`);
    if (next.maxBytes > next.userBytes) throw new HttpError(400, 'one artifact may not be larger than all of a user\'s together');
    if (patch.linkBase !== undefined) next.linkBase = linkBaseOf(patch.linkBase, o.edge.origins());
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
    // With the owner (issue #673): they see it already; nothing is made.
    if ('owner' in made) return { artifact: viewOf(req, t, id), owner: true };
    // The link is said once, here: only its hash is kept.
    return { artifact: viewOf(req, t, id), share: made.share, ...(made.token ? { link: `${o.edge.viewBase(req, t)}${LINK_PATH}/${made.token}` } : {}) };
  });

  app.post('/ui/api/artifacts/:id/shares/:share/revoke', o.operator, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id, share } = parseWith(shareParams, req.params);
    const r = t.artifacts.revoke(id, share, who);
    if (isRefusal(r)) return refused(r);
    return { artifact: viewOf(req, t, id) };
  });

  // Issue #675: the revision becomes the latest as a new one; the id, its links and its shares stay.
  app.post('/ui/api/artifacts/:id/restore', o.operator, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id } = parseWith(params, req.params);
    const { revision } = parseWith(artifactRestoreBody, req.body);
    const r = t.artifacts.restore(id, revision, who);
    if (isRefusal(r)) return refused(r);
    return { artifact: viewOf(req, t, id) };
  });

  // Issue #687: the owner's own revision — a file, or a copy of another artifact's latest content —, `revisedBy` them.
  app.post('/ui/api/artifacts/:id/revisions', { ...o.operator, bodyLimit: REVISE_BODY_LIMIT }, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id } = parseWith(params, req.params);
    const body = parseWith(artifactReviseBody, req.body);
    const r = t.artifacts.revise(id, 'from' in body
      ? { from: body.from, ...(body.note !== undefined ? { note: body.note } : {}) }
      : { file: { name: body.file.name, content: Buffer.from(body.file.content, 'base64'), ...(body.file.type ? { type: body.file.type } : {}) }, ...(body.note !== undefined ? { note: body.note } : {}) }, who);
    if (isRefusal(r)) return refused(r);
    return { artifact: viewOf(req, t, id) };
  });

  // Issue #687: each source's revisions are added to this one, oldest first; the source goes once they are in.
  app.post('/ui/api/artifacts/:id/merge', o.operator, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id } = parseWith(params, req.params);
    const { from } = parseWith(artifactMergeBody, req.body);
    const r = t.artifacts.merge(id, from, who);
    if (isRefusal(r)) return refused(r);
    return { artifact: viewOf(req, t, id), merged: r.merged };
  });

  app.post('/ui/api/artifacts/:id/revisions/:n/pin', o.operator, async (req) => {
    const who = by(req);
    const t = o.tenant(req);
    const { id, n } = parseWith(revisionParams, req.params);
    const { pinned } = parseWith(artifactPinBody, req.body);
    const r = t.artifacts.pin(id, n, pinned, who);
    if (isRefusal(r)) return refused(r);
    return { revision: o.edge.revisionView(r, t.artifacts.get(id)!.userId, userIdOf(req)!) };
  });

  app.post('/ui/api/artifacts/:id/remove', o.operator, async (req) => {
    const who = by(req);
    const { id } = parseWith(params, req.params);
    const r = o.tenant(req).artifacts.remove(id, who);
    if (isRefusal(r)) return refused(r);
    return { removed: r.id };
  });
}
