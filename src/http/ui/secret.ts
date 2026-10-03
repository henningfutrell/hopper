import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, hex: login codes and session tokens. */
export const randomSecret = (): string => randomBytes(32).toString('hex');

/** Constant-time comparison; false for different lengths. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
