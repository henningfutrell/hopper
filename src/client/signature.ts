// How the hopper and a hopper client prove themselves to each other over HTTP (design.md "Target
// authentication", issue #59), with the client's token — a shared secret both get from their runtime.
// The token never crosses the wire. A request carries `x-hopper-signature: ts=<ms>,nonce=<hex>,sig=<b64url>`,
// sig = HMAC-SHA256(token, "hopper-request" ‖ method ‖ path ‖ ts ‖ nonce ‖ sha256(body)); the client
// accepts it within 30 s of its own clock and once (the nonce). The answer carries
// `x-hopper-client-signature`, HMAC-SHA256(token, "hopper-response" ‖ nonce ‖ status ‖ sha256(body)): bound
// to that one request, so nothing but the client can answer it. node:crypto's HMAC and constant-time
// compare; the client is installed as plain files, so no dependency is worth more than these lines.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const REQUEST_HEADER = 'x-hopper-signature';
export const RESPONSE_HEADER = 'x-hopper-client-signature';
export const WINDOW_MS = 30000;
/** 256 bits, base64url: the shortest token accepted. */
const MIN_TOKEN = 43;

/** A new client token: 256 bits from the OS random source, base64url. */
export const mintToken = (): string => randomBytes(32).toString('base64url');

/** The token, or a throw when it is too short to be safe. */
export function checkToken(token: string): string {
  if (token.length < MIN_TOKEN) throw new Error(`a client token must be at least ${MIN_TOKEN} characters (256 bits, base64url); scripts/attach-client.sh mints one`);
  return token;
}

const sha256 = (body: string): string => createHash('sha256').update(body).digest('hex');
const mac = (token: string, parts: string[]): string => createHmac('sha256', token).update(parts.join('\n')).digest('base64url');

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signRequest(token: string, method: string, path: string, body: string, now = Date.now()): string {
  const nonce = randomBytes(16).toString('hex');
  return `ts=${now},nonce=${nonce},sig=${mac(token, ['hopper-request', method, path, String(now), nonce, sha256(body)])}`;
}

/** Nonces seen within the window: a request is accepted once. */
export interface NonceCache { seen(nonce: string, now: number): boolean }

export function createNonceCache(windowMs = WINDOW_MS): NonceCache {
  const seen = new Map<string, number>();
  return {
    seen(nonce, now) {
      for (const [n, at] of seen) if (now - at > 2 * windowMs) seen.delete(n);
      if (seen.has(nonce)) return true;
      seen.set(nonce, now);
      return false;
    },
  };
}

const HEADER = /^ts=(\d{1,16}),nonce=([0-9a-f]{32}),sig=([A-Za-z0-9_-]{43})$/;

export type Verdict = { ok: true; nonce: string } | { ok: false; why: 'unsigned' | 'stale' | 'bad signature' | 'replayed' };

export function verifyRequest(token: string, header: string | undefined, method: string, path: string, body: string, nonces: NonceCache, now = Date.now()): Verdict {
  const m = header ? HEADER.exec(header) : null;
  if (!m) return { ok: false, why: 'unsigned' };
  const [, ts, nonce, sig] = m as unknown as [string, string, string, string];
  if (Math.abs(now - Number(ts)) > WINDOW_MS) return { ok: false, why: 'stale' };
  if (!same(sig, mac(token, ['hopper-request', method, path, ts, nonce, sha256(body)]))) return { ok: false, why: 'bad signature' };
  if (nonces.seen(nonce, now)) return { ok: false, why: 'replayed' };
  return { ok: true, nonce };
}

/** The nonce a signed request carries (the hopper keeps it to check the answer). */
export const nonceOf = (header: string): string => HEADER.exec(header)?.[2] ?? '';

export function signResponse(token: string, nonce: string, status: number, body: string): string {
  return mac(token, ['hopper-response', nonce, String(status), sha256(body)]);
}

export function verifyResponse(token: string, header: string | undefined, nonce: string, status: number, body: string): boolean {
  return header !== undefined && same(header, signResponse(token, nonce, status, body));
}
