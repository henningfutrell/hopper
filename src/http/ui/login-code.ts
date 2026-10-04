// The one-time UI login code (design.md "UI session and mutations" 1): a fresh random code in
// <dataDir>/ui-login-code, mode 0600, written at startup and after every successful use.
// Written to a temp file and renamed, so a reader never sees a half-written code.
import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomSecret, sameSecret } from './secret.ts';

export const LOGIN_CODE_FILE = 'ui-login-code';

export interface LoginCode {
  readonly path: string;
  /** The code that works now (for a device link). */
  current(): string;
  /** Write a fresh code; the old one stops working. */
  rotate(): void;
  /** True (and the code rotates) when `code` is the current one. */
  use(code: string): boolean;
}

export function createLoginCode(dataDir: string): LoginCode {
  const path = join(dataDir, LOGIN_CODE_FILE);
  let current = '';
  const rotate = (): void => {
    const next = randomSecret();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${next}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    current = next;
  };
  return {
    path,
    rotate,
    current: () => current,
    use(code) {
      if (!sameSecret(code, current)) return false;
      rotate();
      return true;
    },
  };
}
