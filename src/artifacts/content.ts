// How an artifact's content is served (issue #624, design.md "Artifacts"): the headers for each kind, and the signed
// URL a viewer's browser loads it from. Content is never served under /api/ and needs no UI session: the UI session is
// a header a browser cannot put on an <img> or <iframe>, so the read that checked the viewer signs a URL that works for
// a short time, and the content route checks the signature, and again the viewer's access, at each load.
//
// HTML runs only in a sandbox: CSP `sandbox` without `allow-same-origin` gives the page an opaque origin, so it reads
// none of the hopper's storage, cookies or session, and `connect-src 'none'` keeps it from calling any URL; its scripts
// run inside it. SVG is a drawing a job makes, as HTML is: it gets the same sandbox (issue #675). The text kinds get a
// sandbox with no script at all. Pure but for the key.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ArtifactKind } from '../domain/artifacts.ts';

/** How long a signed content URL works. */
export const CONTENT_URL_SECONDS = 3600;
/** Where content is served: `<CONTENT_PATH>/<file name>?v=<signed token>`; a public link at `<LINK_PATH>/<token>`. */
export const CONTENT_PATH = '/artifact-content';
export const LINK_PATH = '/artifact-link';

/** An HTML or SVG artifact's policy: its scripts run, in a sandbox of its own origin, and it reaches nothing. */
export const HTML_POLICY = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  'img-src https: data: blob:',
  'font-src https: data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');
/** Every other kind's: a sandbox in which nothing runs and nothing is fetched. */
export const INERT_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

/** The headers an artifact is served with. Text kinds go as plain text: the UI renders the previews. */
export function contentHeaders(a: { kind: ArtifactKind; type: string; name: string }, download: boolean): Record<string, string> {
  const type = a.kind === 'html' ? 'text/html; charset=utf-8'
    : a.kind === 'csv' || a.kind === 'markdown' || a.kind === 'json' || a.kind === 'text' ? 'text/plain; charset=utf-8'
      : a.kind === 'file' ? 'application/octet-stream' : a.type;
  const policy = a.kind === 'html' || a.kind === 'svg' ? HTML_POLICY : a.kind === 'pdf' ? "frame-ancestors 'self'" : INERT_POLICY;
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

/** A signer over a key of this process: a restart ends every signed URL, and a read signs a new one. */
export function createContentSigner(o: { now(): number; key?: Buffer; seconds?: number }): ContentSigner {
  const key = o.key ?? randomBytes(32);
  const mac = (body: string): Buffer => createHmac('sha256', key).update(body).digest();
  return {
    sign(g) {
      const body = Buffer.from(JSON.stringify({ o: g.owner, a: g.id, v: g.viewer, u: o.now() + (o.seconds ?? CONTENT_URL_SECONDS) * 1000 })).toString('base64url');
      return `${body}.${mac(body).toString('base64url')}`;
    },
    verify(token) {
      const [body, sig] = token.split('.');
      if (!body || !sig) return undefined;
      const want = mac(body);
      const got = Buffer.from(sig, 'base64url');
      if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
      try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { o: string; a: string; v: string; u: number };
        if (typeof p.o !== 'string' || typeof p.a !== 'string' || typeof p.v !== 'string' || typeof p.u !== 'number' || p.u <= o.now()) return undefined;
        return { owner: p.o, id: p.a, viewer: p.v, until: p.u };
      } catch {
        return undefined;
      }
    },
  };
}
