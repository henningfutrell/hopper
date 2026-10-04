// A device link (design.md "Reaching the UI across the LAN") carries the login code in the URL
// fragment, which the browser never sends to the server; the page reads it once and posts it.
import { describe, expect, it } from 'vitest';
import { loginCodeFromHash } from '../../ui/src/lib/login.ts';

const CODE = 'a'.repeat(64);

describe('loginCodeFromHash', () => {
  it('reads a 64-hex code from #login=', () => {
    expect(loginCodeFromHash(`#login=${CODE}`)).toBe(CODE);
  });

  it('anything else is not a login link', () => {
    for (const hash of ['', '#', '#question-q1', `#login=${CODE.slice(1)}`, `#login=${'g'.repeat(64)}`, `#login=${CODE}x`]) {
      expect(loginCodeFromHash(hash), hash).toBeNull();
    }
  });
});
