// One-time join codes (design.md "Joining a machine", issue #308): minted for one user by an admin's Add
// machine (or the operator CLI, for a script), presented once by the machine that joins with it. Only
// the code's SHA-256 is stored; a code expires JOIN_CODE_MINUTES after it is minted. The same shape as a
// login code, a machine's instead of a browser's.
import { createHash, randomBytes } from 'node:crypto';
import type { Clock, InstanceStore } from '../domain/ports.ts';

export const JOIN_CODE_MINUTES = 10;

const hash = (code: string): string => createHash('sha256').update(code).digest('hex');

/** A fresh code for `userId` — naming the box template the machine joins as, if any (issue #558) —, stored (hashed) until it is used or expires. */
export function mintJoinCode(store: Pick<InstanceStore, 'joinCodes'>, clock: Clock, userId: string, template?: string): { code: string; expiresAt: string } {
  const code = randomBytes(32).toString('hex');
  const expiresAt = new Date(clock.now().getTime() + JOIN_CODE_MINUTES * 60_000).toISOString();
  store.joinCodes.create(hash(code), expiresAt, userId, template);
  return { code, expiresAt };
}

/** The user of `code` (and its box template), and the code is spent, when it was minted and has not expired; undefined else. */
export function useJoinCode(store: Pick<InstanceStore, 'joinCodes'>, clock: Clock, code: string): { userId: string; template?: string } | undefined {
  return /^[0-9a-f]{64}$/.test(code) ? store.joinCodes.take(hash(code), clock.now().toISOString()) : undefined;
}
