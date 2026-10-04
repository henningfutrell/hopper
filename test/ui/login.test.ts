// A device link (design.md "Reaching the UI across the LAN") carries the login code in the URL
// fragment, which the browser never sends to the server; the page reads it once and posts it.
import { describe, expect, it } from 'vitest';
import { loginCodeFromHash, newBinding, signInPath, wantsNoSignIn } from '../../ui/src/lib/login.ts';

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

describe('provider sign-in (issue #39)', () => {
  it('a binding is fresh random base64url, long enough for the daemon', () => {
    const a = newBinding();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(newBinding()).not.toBe(a);
  });

  it('the start path names the provider and carries the binding', () => {
    expect(signInPath('corp', 'b'.repeat(43))).toBe(`/ui/auth/corp/start?binding=${'b'.repeat(43)}`);
  });
});

describe('no sign-in and password sign-in (issue #53)', () => {
  const offer = (o: Partial<{ none: 'viewer' | 'operator' | 'admin' | null; password: boolean }>) => ({ local: false, none: null, password: false, origin: 'http://localhost:1', providers: [], ...o });

  it('signs in without a credential only when logged out and no sign-in is on', () => {
    expect(wantsNoSignIn(false, offer({ none: 'viewer' }))).toBe(true);
    expect(wantsNoSignIn(true, offer({ none: 'viewer' }))).toBe(false);
    expect(wantsNoSignIn(false, offer({}))).toBe(false);
    expect(wantsNoSignIn(false, null)).toBe(false);
  });
});
