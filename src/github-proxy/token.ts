// A job's proxy token (issue #563, design.md "GitHub through the hopper"): what a running job shows the hopper
// to ask it for a GitHub operation. Derived, never stored: an HMAC of the user and the job under a key the
// hopper derives from that user's link key (issue #308), which never leaves the hopper. The same job always
// gets the same token, so a restart or a renewal changes nothing on its machine; it is honoured only while
// its job is at work, so a token of an ended job opens nothing.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** A job's proxy token: `<user id, base64url>.<job id>.<mac>`. */
export interface ProxyTokenParts { userId: string; jobId: string; mac: string }

const keyOf = (linkPrivateKey: string, userId: string): Buffer =>
  Buffer.from(hkdfSync('sha256', linkPrivateKey, 'hopper-job-proxy/1', userId, 32));

const macOf = (linkPrivateKey: string, userId: string, jobId: string): string =>
  createHmac('sha256', keyOf(linkPrivateKey, userId)).update(jobId).digest('base64url');

/** The proxy token of `jobId`, a job of `userId`, under that user's link key. */
export function proxyToken(linkPrivateKey: string, userId: string, jobId: string): string {
  return `${Buffer.from(userId).toString('base64url')}.${jobId}.${macOf(linkPrivateKey, userId, jobId)}`;
}

const PART = /^[A-Za-z0-9_-]{1,200}$/;

/** A token's parts; undefined when it is not one. */
export function parseProxyToken(token: string): ProxyTokenParts | undefined {
  const [user, jobId, mac, ...rest] = token.split('.');
  if (rest.length > 0 || !user || !jobId || !mac || ![user, jobId, mac].every((p) => PART.test(p))) return undefined;
  return { userId: Buffer.from(user, 'base64url').toString('utf8'), jobId, mac };
}

/** Whether `mac` is the one the user's link key gives the job: compared in constant time. */
export function holdsProxyToken(linkPrivateKey: string, parts: ProxyTokenParts): boolean {
  const want = Buffer.from(macOf(linkPrivateKey, parts.userId, parts.jobId));
  const got = Buffer.from(parts.mac);
  return want.length === got.length && timingSafeEqual(want, got);
}
