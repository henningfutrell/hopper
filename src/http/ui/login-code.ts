// One-time UI login codes (design.md "UI session and mutations" 1): minted into the store for one
// user (issue #158) — by the operator's `hopper login-code`, for a device link, or for a new user's
// login link — and taken once by POST /ui/login. Only the code's SHA-256 is stored; a code expires
// LOGIN_CODE_MINUTES after it is minted.
import { createHash } from 'node:crypto';
import type { Clock, InstanceStore } from '../../domain/ports.ts';
import { randomSecret } from './secret.ts';

export const LOGIN_CODE_MINUTES = 10;

const hash = (code: string): string => createHash('sha256').update(code).digest('hex');

/** A fresh code for `userId`, stored (hashed) until it is used or expires. */
export function mintLoginCode(store: Pick<InstanceStore, 'loginCodes'>, clock: Clock, userId: string): string {
  const code = randomSecret();
  store.loginCodes.create(hash(code), new Date(clock.now().getTime() + LOGIN_CODE_MINUTES * 60_000).toISOString(), userId);
  return code;
}

/** The user of `code` when it was minted, is not yet used, and has not expired; undefined else. The code stays. */
export function loginCodeLive(store: Pick<InstanceStore, 'loginCodes'>, clock: Clock, code: string): string | undefined {
  return /^[0-9a-f]{64}$/.test(code) ? store.loginCodes.live(hash(code), clock.now().toISOString()) : undefined;
}

/** The user of `code`, and the code is spent, when it was minted and has not expired; undefined else. */
export function useLoginCode(store: Pick<InstanceStore, 'loginCodes'>, clock: Clock, code: string): string | undefined {
  return /^[0-9a-f]{64}$/.test(code) ? store.loginCodes.take(hash(code), clock.now().toISOString()) : undefined;
}
