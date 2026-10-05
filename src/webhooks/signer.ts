import { createHmac, timingSafeEqual } from 'node:crypto';

/** `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<rawBody>")>` — the x-hopper-signature value. */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Constant-time check of a received signature. For receivers and tests. */
export function verify(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
