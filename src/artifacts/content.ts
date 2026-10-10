// How an artifact's content is served (issue #624, design.md "Artifacts"): the headers for each kind, and the signed
// URL a viewer's browser loads it from. Content is never served under /api/ and needs no UI session: the UI session is
// a header a browser cannot put on an <img> or <iframe>, so the read that checked the viewer signs a URL that works for
// a short time, and the content route checks the signature, and again the viewer's access, at each load.
//
// HTML runs only in a sandbox: CSP `sandbox` without `allow-same-origin` gives the page an opaque origin, so it reads
// none of the hopper's storage, cookies or session, and `connect-src 'none'` keeps it from calling any URL; its scripts
// run inside it, and it loads only what it carries (issue #673). SVG is a drawing a job makes, as HTML is: it gets the
// same sandbox (issue #675). The text kinds get a sandbox with no script at all. Pure but for the key.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ArtifactKind } from '../domain/artifacts.ts';
import { ARTIFACT_LIB_PATH } from './libs.ts';

/** How long a signed content URL works. */
export const CONTENT_URL_SECONDS = 3600;
/** Where content is served: `<CONTENT_PATH>/<file name>?v=<signed token>`; a public link at `<LINK_PATH>/<token>`. */
export const CONTENT_PATH = '/artifact-content';
export const LINK_PATH = '/artifact-link';

/** What an HTML or SVG artifact may load, each kind: only what it carries itself (issue #673). */
const OWN_ONLY = "'unsafe-inline' data: blob:";
/**
 * An HTML or SVG artifact's policy: its scripts run, in a sandbox of its own origin, and it reaches nothing. It loads nothing
 * from outside either (issue #673): an `<img>` or `<script>` from any https address is a request out, and its URL can
 * carry what the page read — its own signed content URL included. A popup it opens stays in the sandbox. Its scripts may
 * also come from the hopper's own `/artifact-lib/` (issue #675): the diagram and chart libraries the hopper bundles,
 * at `origin` — the address the person opened it at, so the path matches wherever they are. A request there reaches
 * the hopper only, never outside.
 */
export function htmlPolicy(origin: string): string {
  return [
    'sandbox allow-scripts allow-popups allow-downloads',
    "default-src 'none'",
    `script-src ${OWN_ONLY} ${origin}${ARTIFACT_LIB_PATH}/`,
    `style-src ${OWN_ONLY}`,
    `img-src ${OWN_ONLY}`,
    `font-src ${OWN_ONLY}`,
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}
/** Every other kind's: a sandbox in which nothing runs and nothing is fetched. */
export const INERT_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

/** The headers an artifact is served with. Text kinds go as plain text: the UI renders the previews. */
export function contentHeaders(a: { kind: ArtifactKind; type: string; name: string }, download: boolean, origin: string): Record<string, string> {
  const type = a.kind === 'html' ? 'text/html; charset=utf-8'
    : a.kind === 'csv' || a.kind === 'markdown' || a.kind === 'json' || a.kind === 'text' ? 'text/plain; charset=utf-8'
      : a.kind === 'file' ? 'application/octet-stream' : a.type;
  const policy = a.kind === 'html' || a.kind === 'svg' ? htmlPolicy(origin) : a.kind === 'pdf' ? "frame-ancestors 'self'" : INERT_POLICY;
  const attach = download || a.kind === 'file';
  return {
    'content-type': type,
    'content-security-policy': policy,
    'x-content-type-options': 'nosniff',
    // The signed URL is a credential for a while: no page it loads learns it.
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'cross-origin-resource-policy': 'same-origin',
    'content-disposition': `${attach ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
  };
}

/** What a signed content URL lets: `viewer` (a user id) see the artifact `id` of `owner`, until `until` (ms). */
export interface ContentGrant { owner: string; id: string; viewer: string; until: number }

export interface ContentSigner {
  sign(g: Omit<ContentGrant, 'until'>): string;
  /** The grant a token holds, when its signature checks out and it has not run out; else undefined. */
  verify(token: string): ContentGrant | undefined;
}

/**
 * A signer over each owner's key (issue #673): the key of the artifact's owner signs, and the owner the token names picks
 * the key that checks it. `key` answers undefined for an owner the hopper does not have: nothing of theirs verifies.
 */
export function createContentSigner(o: { now(): number; key(owner: string): Buffer | undefined; seconds?: number }): ContentSigner {
  const mac = (key: Buffer, body: string): Buffer => createHmac('sha256', key).update(body).digest();
  return {
    sign(g) {
      const key = o.key(g.owner);
      if (!key) throw new Error(`no content URL key for user ${g.owner}`);
      const body = Buffer.from(JSON.stringify({ o: g.owner, a: g.id, v: g.viewer, u: o.now() + (o.seconds ?? CONTENT_URL_SECONDS) * 1000 })).toString('base64url');
      return `${body}.${mac(key, body).toString('base64url')}`;
    },
    verify(token) {
      const [body, sig] = token.split('.');
      if (!body || !sig) return undefined;
      let p: { o: string; a: string; v: string; u: number };
      try {
        p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof p;
      } catch {
        return undefined;
      }
      if (typeof p.o !== 'string' || typeof p.a !== 'string' || typeof p.v !== 'string' || typeof p.u !== 'number') return undefined;
      const key = o.key(p.o);
      if (!key) return undefined;
      const want = mac(key, body);
      const got = Buffer.from(sig, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
      return p.u > o.now() ? { owner: p.o, id: p.a, viewer: p.v, until: p.u } : undefined;
    },
  };
}
