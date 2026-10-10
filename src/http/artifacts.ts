// Artifacts at the HTTP edge (issue #624, design.md "Artifacts"): the reads, and where the content is served.
//
//   GET /api/artifacts             the user's artifacts with their shares (`?job=ID`: one job's), the ones other users
//                                  shared with them (Access decides each), the bytes used and Settings → Artifacts.
//   GET /api/artifacts/:id         one artifact: the user's own, or one shared with them.
//   GET /api/artifacts/:id/revisions[/:n]
//                                  its revisions, newest first, or one (issue #675), each with its content URL.
//   GET /artifact-content/:name?v=TOKEN[&revision=N]
//                                  the content, for the viewer a read signed it for, while the signature lasts
//                                  (`&download=1`: as a download; `&revision=N`: that revision, else the latest). The
//                                  owner's always; another user's only while Access says it is shared with them,
//                                  checked at each load.
//   GET /artifact-link/:token[?revision=N]
//                                  a public link (issue #675): the share page — the title and summary, for a phone and
//                                  for share previews, around the content, framed —, while the link is live, public
//                                  links are on for the owner, and Access says the link may see it. No session: the link
//                                  is the credential. It follows the latest revision, or `revision=N` pins one.
//   GET /artifact-link/:token/content[?revision=N][&download=1]
//                                  the content the share page frames, on the same terms.
//
// No content route is under /api/: a browser loads it into an <img> or a sandboxed <iframe>, which carries no session
// header. Each serves under the policy of its kind (src/artifacts/content.ts), for the origin the request came in on.
// Nothing here changes anything.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ArtifactViewer, Access } from '../authz/service.ts';
import { artifactBase, artifactUrl, CONTENT_PATH, contentHeaders, createContentSigner, LINK_PATH, type ContentSigner } from '../artifacts/index.ts';
import { shareLive, type Artifact, type ArtifactRevision, type ArtifactRevisionView, type ArtifactShare, type ArtifactView, type ArtifactsView } from '../domain/artifacts.ts';
import type { Clock } from '../domain/ports.ts';
import { HttpError } from './errors.ts';
import { FAVICON_LINK } from './static.ts';

/** What the share page's frame lets an HTML or SVG artifact do: the UI's own (ui/src/model/artifacts.ts FRAME_SANDBOX). */
const FRAME_SANDBOX = 'allow-scripts allow-popups allow-downloads';
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
  /** A revision as `viewer` reads it (issue #675): its signed content URL. */
  revisionView(r: ArtifactRevision, owner: string, viewer: string): ArtifactRevisionView;
}

export function createArtifactEdge(o: { clock: Clock; lan: Lan; port: () => number; tenants: Pick<Tenants, 'user'> }): ArtifactEdge {
  const signer = createContentSigner({ now: () => o.clock.now().getTime(), key: (owner) => o.tenants.user(owner)?.artifacts.contentKey() });
  const edge: ArtifactEdge = {
    signer,
    base: (t) => artifactBase({ linkBase: t.artifacts.settings().linkBase, publicUrl: o.lan.publicUrl, lanNames: o.lan.names, port: o.port() }),
    baseOf(req) {
      const host = (req.headers.host ?? '').toLowerCase();
      // The Host guard let it in: it is loopback, a LAN name or the public URL's host.
      if (o.lan.publicUrl && publicHosts(o.lan).includes(host)) return new URL(o.lan.publicUrl).origin;
      return host ? `http://${host}` : `http://127.0.0.1:${o.port()}`;
    },
    publicBase: () => (o.lan.publicUrl ? new URL(o.lan.publicUrl).origin : undefined),
    origins: () => uiOrigins(o.port(), o.lan).map((u) => new URL(u).origin),
    url: artifactUrl,
    view(t, a, viewer, base, owner) {
      const token = signer.sign({ owner: a.userId, id: a.id, viewer });
      return {
        ...a, url: edge.url(base, a.id), contentUrl: `${CONTENT_PATH}/${encodeURIComponent(a.name)}?v=${token}`,
        ...(owner !== undefined ? { owner } : { shares: t.store.artifacts.shares(a.id) }),
      };
    },
    revisionView(r, owner, viewer) {
      const token = signer.sign({ owner, id: r.artifactId, viewer });
      return { ...r, contentUrl: `${CONTENT_PATH}/${encodeURIComponent(r.name)}?v=${token}&revision=${r.n}` };
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

/** A revision a query names (`revision=N`, issue #675); undefined: none named, the latest. NaN: not a revision number. */
const revisionOf = (req: FastifyRequest): number | undefined => {
  const v = (req.query as Record<string, unknown>).revision;
  if (v === undefined || v === '') return undefined;
  return typeof v === 'string' && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : Number.NaN;
};

const NO_REVISION = 'no: the artifact has no such revision: it was never made, or the retention removed it\n';

/** The content of the latest revision, or of revision `n`: its own name and type, under its kind's policy. */
const sendContent = (reply: FastifyReply, t: TenantParts, a: Artifact, o: { download: boolean; origin: string; revision?: number }): FastifyReply => {
  const rev = o.revision === undefined ? undefined : t.artifacts.revision(a.id, o.revision);
  if (o.revision !== undefined && !rev) return reply.code(404).type('text/plain; charset=utf-8').send(NO_REVISION);
  const body = rev ? t.artifacts.revisionContent(a.id, rev.n) : t.artifacts.content(a.id);
  if (!body) return reply.code(404).type('text/plain; charset=utf-8').send('no: the artifact is gone\n');
  return reply.headers(contentHeaders(rev ?? a, o.download, o.origin)).send(body);
};

const GONE_LINK = 'no: this link does not work: it expired, it was revoked, or it never was\n';

/** The share page's own policy: no script; it frames the content from the hopper itself. */
export const SHARE_PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The page a public link opens (issue #675): it fits a phone, names the artifact by its title and summary — what a chat
 * app's share preview reads, as Open Graph tags — and frames the content below, sandboxed as the UI frames it. Pure.
 */
export function sharePage(a: Artifact, o: { token: string; revision?: ArtifactRevision }): string {
  const shown = o.revision ?? a;
  const title = esc(shown.title);
  const summary = shown.summary !== undefined ? esc(shown.summary) : '';
  const q = o.revision ? `?revision=${o.revision.n}` : '';
  const content = `${LINK_PATH}/${encodeURIComponent(o.token)}/content${q}`;
  const download = `${content}${q ? '&' : '?'}download=1`;
  const which = o.revision && o.revision.n !== a.revision
    ? `Revision ${o.revision.n} of ${a.revision} · <a href="${LINK_PATH}/${encodeURIComponent(o.token)}">open the latest</a>`
    : `Revision ${a.revision}`;
  const frame = shown.kind === 'image'
    ? `<img src="${content}" alt="${title}">`
    : shown.kind === 'file'
      ? `<p>No preview for ${esc(shown.type)}.</p>`
      // The browser's PDF viewer needs no sandbox (the UI frames it so too); HTML and SVG get the UI's frame sandbox.
      : `<iframe title="${title}"${shown.kind === 'pdf' ? '' : ` sandbox="${shown.kind === 'html' || shown.kind === 'svg' ? FRAME_SANDBOX : ''}"`} src="${content}" referrerpolicy="no-referrer"></iframe>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${summary ? `<meta name="description" content="${summary}">\n` : ''}<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
${summary ? `<meta property="og:description" content="${summary}">\n` : ''}<meta name="robots" content="noindex">
${FAVICON_LINK}
<style>
html,body{margin:0;height:100%}
body{display:flex;flex-direction:column;font:15px/1.4 system-ui,sans-serif;color:#1d1d1f;background:#f6f6f7}
header{padding:10px 14px;border-bottom:1px solid #ddd;background:#fff}
h1{margin:0;font-size:17px;line-height:1.3}
p{margin:4px 0 0;color:#555}
.meta{font-size:12px;color:#777}
.meta a{color:inherit}
main{flex:1;display:flex;min-height:0}
iframe{flex:1;border:0;width:100%;min-height:70vh;background:#fff}
img{max-width:100%;height:auto;margin:auto;display:block}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}header{background:#1a1a1a;border-color:#333}p{color:#bbb}.meta{color:#999}}
</style>
</head>
<body>
<header>
<h1>${title}</h1>
${summary ? `<p>${summary}</p>\n` : ''}<p class="meta">${which} · ${esc(shown.name)} · <a href="${download}">download</a></p>
</header>
<main>${frame}</main>
</body>
</html>
`;
}

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

  /** The artifact `id` as the viewer may read it: their own, or one Access lets them see; else 404. */
  const found = async (req: FastifyRequest, id: string): Promise<{ t: TenantParts; a: Artifact; owner?: string; me: string }> => {
    const t = o.tenant(req);
    const me = viewerOf(req);
    const own = t.artifacts.get(id);
    if (own) return { t, a: own, me };
    const shared = (await sharedWith(o.tenants, o.access, me, now())).find((s) => s.a.id === id);
    if (!shared) throw new HttpError(404, `no artifact ${id} of yours or shared with you`);
    return { t: shared.t, a: shared.a, owner: shared.owner, me };
  };

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply): Promise<ArtifactView> => {
    void reply.header('cache-control', 'no-store');
    const f = await found(req, req.params.id);
    return o.edge.view(f.t, f.a, f.me, o.edge.baseOf(req), f.owner);
  });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id/revisions', async (req, reply): Promise<{ revisions: ArtifactRevisionView[] }> => {
    void reply.header('cache-control', 'no-store');
    const f = await found(req, req.params.id);
    return { revisions: f.t.artifacts.revisions(f.a.id).map((r) => o.edge.revisionView(r, f.a.userId, f.me)) };
  });

  app.get<{ Params: { id: string; n: string } }>('/api/artifacts/:id/revisions/:n', async (req, reply): Promise<ArtifactRevisionView> => {
    void reply.header('cache-control', 'no-store');
    const f = await found(req, req.params.id);
    const r = /^[1-9]\d{0,8}$/.test(req.params.n) ? f.t.artifacts.revision(f.a.id, Number(req.params.n)) : undefined;
    if (!r) throw new HttpError(404, `artifact ${f.a.id} has no revision ${req.params.n}`);
    return o.edge.revisionView(r, f.a.userId, f.me);
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
    const revision = revisionOf(req);
    if (Number.isNaN(revision)) return reply.code(404).type('text/plain; charset=utf-8').send(NO_REVISION);
    return sendContent(reply, t, a, { download: (req.query as Record<string, unknown>).download === '1', origin: o.edge.baseOf(req), ...(revision !== undefined ? { revision } : {}) });
  });

  /** The live link a token names, and its artifact; undefined: it does not work. */
  const linked = async (token: string): Promise<{ t: TenantParts; a: Artifact; share: ArtifactShare } | undefined> => {
    const owner = token.slice(0, Math.max(0, token.indexOf('.')));
    const t = owner ? o.tenants.user(owner) : undefined;
    const share = t?.artifacts.shareOfToken(token);
    const a = share ? t!.artifacts.get(share.artifactId) : undefined;
    if (!t || !share || !a || share.kind !== 'link' || !shareLive(share, now()) || !t.artifacts.settings().publicLinks) return undefined;
    const viewer: ArtifactViewer = { kind: 'link', userId: owner, shareId: share.id };
    if (!(await o.access.decideView(viewer, a)).allowed) return undefined;
    return { t, a, share };
  };

  app.get<{ Params: { token: string } }>(`${LINK_PATH}/:token`, async (req, reply) => {
    const l = await linked(req.params.token);
    if (!l) return reply.code(404).type('text/plain; charset=utf-8').send(GONE_LINK);
    const n = revisionOf(req);
    const revision = n === undefined ? undefined : Number.isNaN(n) ? undefined : l.t.artifacts.revision(l.a.id, n);
    if (n !== undefined && !revision) return reply.code(404).type('text/plain; charset=utf-8').send(NO_REVISION);
    return reply.headers({
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': SHARE_PAGE_POLICY, 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'cache-control': 'private, no-store',
    }).send(sharePage(l.a, { token: req.params.token, ...(revision ? { revision } : {}) }));
  });

  app.get<{ Params: { token: string } }>(`${LINK_PATH}/:token/content`, async (req, reply) => {
    const l = await linked(req.params.token);
    if (!l) return reply.code(404).type('text/plain; charset=utf-8').send(GONE_LINK);
    const revision = revisionOf(req);
    if (Number.isNaN(revision)) return reply.code(404).type('text/plain; charset=utf-8').send(NO_REVISION);
    return sendContent(reply, l.t, l.a, { download: (req.query as Record<string, unknown>).download === '1', origin: o.edge.baseOf(req), ...(revision !== undefined ? { revision } : {}) });
  });
}
