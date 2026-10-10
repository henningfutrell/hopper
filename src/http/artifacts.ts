// Artifacts at the HTTP edge (issue #624, design.md "Artifacts"): the reads, and where the content is served.
//
//   GET /api/artifacts             the user's artifacts with their shares (`?job=ID`: one job's), the ones other users
//                                  shared with them (Access decides each), the bytes used and Settings → Artifacts.
//   GET /api/artifacts/:id         one artifact: the user's own, or one shared with them.
//   GET /artifact-content/:name?v=TOKEN
//                                  the content, for the viewer a read signed it for, while the signature lasts
//                                  (`&download=1`: as a download). The owner's always; another user's only while
//                                  Access says it is shared with them, checked at each load.
//   GET /artifact-link/:token      a public link: the content, while the link is live, public links are on for the
//                                  owner, and Access says the link may see it. No session: the link is the credential.
//
// Neither content route is under /api/: a browser loads it into an <img> or a sandboxed <iframe>, which carries no
// session header. Each serves under the policy of its kind (src/artifacts/content.ts). Nothing here changes anything.
import { isIPv4 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ArtifactViewer, Access } from '../authz/service.ts';
import { CONTENT_PATH, contentHeaders, createContentSigner, LINK_PATH, type ContentSigner } from '../artifacts/index.ts';
import { shareLive, type Artifact, type ArtifactView, type ArtifactsView } from '../domain/artifacts.ts';
import type { Clock } from '../domain/ports.ts';
import { HttpError } from './errors.ts';
import { publicHosts, uiOrigins, type Lan } from './reach.ts';
import { userIdOf, type TenantParts, type Tenants } from './tenants.ts';

/** What every artifact route shares: the signer of content URLs, and where people open the hopper. */
export interface ArtifactEdge {
  signer: ContentSigner;
  /**
   * Where a link a job reports points (issue #673), and a notification's: the user's link base (Settings → Artifacts),
   * else the public URL, else the first LAN name that is an IPv4 address or a `.local` name — a bare name is often a
   * container's, which no LAN client resolves —, else the first LAN name, else loopback.
   */
  base(t: Pick<TenantParts, 'artifacts'>): string;
  /** The origin of the Host a request came in on (issue #673): what the viewer used, so a link opens where they are. */
  baseOf(req: FastifyRequest): string;
  /** The public URL, when the hopper has one: the only base a link on GitHub may name. */
  publicBase(): string | undefined;
  /** Every origin the hopper answers to: a link base must be one of them. */
  origins(): string[];
  /** The stable URL of an artifact under `base`: the UI's Artifacts view. */
  url(base: string, id: string): string;
  /** The artifact as `viewer` reads it, its links under `base`: its signed content URL, and for its owner the shares. */
  view(t: TenantParts, a: Artifact, viewer: string, base: string, owner?: string): ArtifactView;
}

/** A LAN name a LAN client resolves without help: an IPv4 address, or a multicast DNS name. */
const resolvable = (name: string): boolean => isIPv4(name) || name.endsWith('.local');

export function createArtifactEdge(o: { clock: Clock; lan: Lan; port: () => number; tenants: Pick<Tenants, 'user'> }): ArtifactEdge {
  const signer = createContentSigner({ now: () => o.clock.now().getTime(), key: (owner) => o.tenants.user(owner)?.artifacts.contentKey() });
  const lanName = (): string | undefined => o.lan.names.find(resolvable) ?? o.lan.names[0];
  const edge: ArtifactEdge = {
    signer,
    base(t) {
      const set = t.artifacts.settings().linkBase;
      if (set) return set;
      const name = lanName();
      return o.lan.publicUrl ? new URL(o.lan.publicUrl).origin : name ? `http://${name}:${o.port()}` : `http://127.0.0.1:${o.port()}`;
    },
    baseOf(req) {
      const host = (req.headers.host ?? '').toLowerCase();
      // The Host guard let it in: it is loopback, a LAN name or the public URL's host.
      if (o.lan.publicUrl && publicHosts(o.lan).includes(host)) return new URL(o.lan.publicUrl).origin;
      return host ? `http://${host}` : `http://127.0.0.1:${o.port()}`;
    },
    publicBase: () => (o.lan.publicUrl ? new URL(o.lan.publicUrl).origin : undefined),
    origins: () => uiOrigins(o.port(), o.lan).map((u) => new URL(u).origin),
    url: (base, id) => `${base}/#artifacts/${id}`,
    view(t, a, viewer, base, owner) {
      const token = signer.sign({ owner: a.userId, id: a.id, viewer });
      return {
        ...a, url: edge.url(base, a.id), contentUrl: `${CONTENT_PATH}/${encodeURIComponent(a.name)}?v=${token}`,
        ...(owner !== undefined ? { owner } : { shares: t.store.artifacts.shares(a.id) }),
      };
    },
  };
  return edge;
}

/** The artifacts other users shared with `userId` that Access lets them see: each with its owner's parts. */
async function sharedWith(tenants: Tenants, access: Access, userId: string, now: string): Promise<{ t: TenantParts; a: Artifact; owner: string }[]> {
  const out: { t: TenantParts; a: Artifact; owner: string }[] = [];
  for (const u of tenants.list()) {
    if (u.id === userId) continue;
    const t = tenants.user(u.id);
    if (!t) continue;
    const ids = new Set(t.store.artifacts.liveShares(now).filter((s) => s.kind === 'user' && s.userId === userId).map((s) => s.artifactId));
    for (const id of ids) {
      const a = t.store.artifacts.get(id);
      if (a && (await access.decideView({ kind: 'user', userId }, a)).allowed) out.push({ t, a, owner: u.name });
    }
  }
  return out;
}

const sendContent = (reply: FastifyReply, t: TenantParts, a: Artifact, download: boolean): FastifyReply => {
  const body = t.artifacts.content(a.id);
  if (!body) return reply.code(404).type('text/plain; charset=utf-8').send('no: the artifact is gone\n');
  return reply.headers(contentHeaders(a, download)).send(body);
};

const GONE_LINK = 'no: this link does not work: it expired, it was revoked, or it never was\n';

export function artifactRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts; tenants: Tenants; access: Access; edge: ArtifactEdge; clock: Clock }): void {
  const now = () => o.clock.now().toISOString();
  const viewerOf = (req: FastifyRequest): string => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to read artifacts');
    return id;
  };

  app.get('/api/artifacts', async (req, reply): Promise<ArtifactsView> => {
    void reply.header('cache-control', 'no-store');
    const t = o.tenant(req);
    const me = viewerOf(req);
    const job = (req.query as Record<string, unknown>).job;
    const mine = t.artifacts.list(typeof job === 'string' && job !== '' ? { jobId: job } : {});
    const shared = await sharedWith(o.tenants, o.access, me, now());
    const base = o.edge.baseOf(req);
    return {
      artifacts: mine.map((a) => o.edge.view(t, a, me, base)),
      shared: shared.map((s) => o.edge.view(s.t, s.a, me, base, s.owner)),
      usedBytes: t.artifacts.usedBytes(),
      settings: t.artifacts.settings(),
    };
  });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply): Promise<ArtifactView> => {
    void reply.header('cache-control', 'no-store');
    const t = o.tenant(req);
    const me = viewerOf(req);
    const own = t.artifacts.get(req.params.id);
    if (own) return o.edge.view(t, own, me, o.edge.baseOf(req));
    const found = (await sharedWith(o.tenants, o.access, me, now())).find((s) => s.a.id === req.params.id);
    if (!found) throw new HttpError(404, `no artifact ${req.params.id} of yours or shared with you`);
    return o.edge.view(found.t, found.a, me, o.edge.baseOf(req), found.owner);
  });

  // The signed token rides in the query: longer than a path parameter may be. The name is the file's, for a download.
  app.get(`${CONTENT_PATH}/:name`, async (req, reply) => {
    const v = (req.query as Record<string, unknown>).v;
    const g = typeof v === 'string' ? o.edge.signer.verify(v) : undefined;
    const t = g ? o.tenants.user(g.owner) : undefined;
    const a = g && t ? t.artifacts.get(g.id) : undefined;
    if (!g || !t || !a) return reply.code(404).type('text/plain; charset=utf-8').send('no: this content URL does not work: it ran out, or the artifact is gone. Open the artifact again.\n');
    if (g.viewer !== g.owner) {
      const d = await o.access.decideView({ kind: 'user', userId: g.viewer }, a);
      if (!d.allowed) return reply.code(403).type('text/plain; charset=utf-8').send(`no: ${d.reason}\n`);
    }
    return sendContent(reply, t, a, (req.query as Record<string, unknown>).download === '1');
  });

  app.get<{ Params: { token: string } }>(`${LINK_PATH}/:token`, async (req, reply) => {
    const gone = () => reply.code(404).type('text/plain; charset=utf-8').send(GONE_LINK);
    const token = req.params.token;
    const owner = token.slice(0, Math.max(0, token.indexOf('.')));
    const t = owner ? o.tenants.user(owner) : undefined;
    const share = t?.artifacts.shareOfToken(token);
    const a = share ? t!.artifacts.get(share.artifactId) : undefined;
    if (!t || !share || !a || share.kind !== 'link' || !shareLive(share, now()) || !t.artifacts.settings().publicLinks) return gone();
    const viewer: ArtifactViewer = { kind: 'link', userId: owner, shareId: share.id };
    if (!(await o.access.decideView(viewer, a)).allowed) return gone();
    return sendContent(reply, t, a, (req.query as Record<string, unknown>).download === '1');
  });
}
