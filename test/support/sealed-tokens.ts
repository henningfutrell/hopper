// The connected accounts' tokens are sealed under the master key (issues #441, #659): a hopper keeps none in clear.
// Tests of the connected accounts seal with TEST_BOX, and read a row as the hopper does, its tokens opened.
import { randomBytes } from 'node:crypto';
import type { ConnectedAccount, UserStore } from '../../src/domain/ports.ts';
import { createTokenBox, isSealed } from '../../src/secrets/token-box.ts';

export const TEST_BOX = createTokenBox(randomBytes(32).toString('hex'));

/** Opened with TEST_BOX; a token another key sealed stays as stored. */
const open = (t: string): string => {
  if (!isSealed(t)) return t;
  try {
    return TEST_BOX.open(t);
  } catch {
    return t;
  }
};

/** The GitHub row of `s`, its tokens opened with TEST_BOX when it sealed them. */
export function openedRow(s: Pick<UserStore, 'connectedAccounts'>): ConnectedAccount | undefined {
  const a = s.connectedAccounts.get('github');
  return a && { ...a, accessToken: open(a.accessToken), ...(a.refreshToken ? { refreshToken: open(a.refreshToken) } : {}) };
}
