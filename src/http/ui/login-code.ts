// One-time UI login codes (design.md "UI session and mutations" 1): minted into the store — by the
// operator's `job-hopper login-code`, or for a device link — and taken once by POST /ui/login. Only
// the code's SHA-256 is stored; a code expires LOGIN_CODE_MINUTES after it is minted.
import { createHash } from 'node:crypto';
import type { Clock, Store } from '../../domain/ports.ts';
import { randomSecret } from './secret.ts';

export const LOGIN_CODE_MINUTES = 10;

const hash = (code: string): string => createHash('sha256').update(code).digest('hex');

/** A fresh code, stored (hashed) until it is used or expires. */
export function mintLoginCode(store: Pick<Store, 'loginCodes'>, clock: Clock): string {
  const code = randomSecret();
  store.loginCodes.create(hash(code), new Date(clock.now().getTime() + LOGIN_CODE_MINUTES * 60_000).toISOString());
  return code;
}

/** True when `code` was minted, is not yet used, and has not expired. The code stays. */
export function loginCodeLive(store: Pick<Store, 'loginCodes'>, clock: Clock, code: string): boolean {
  return /^[0-9a-f]{64}$/.test(code) && store.loginCodes.live(hash(code), clock.now().toISOString());
}

/** True, and the code is spent, when `code` was minted and has not expired. */
export function useLoginCode(store: Pick<Store, 'loginCodes'>, clock: Clock, code: string): boolean {
  return /^[0-9a-f]{64}$/.test(code) && store.loginCodes.take(hash(code), clock.now().toISOString());
}
