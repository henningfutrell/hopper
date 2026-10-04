// Issue #59: the hopper proves itself to a client target with the client's token, over HTTP — and
// the token itself never crosses the wire: every request carries an HMAC of what it asks, fresh
// (a timestamp window) and once (a nonce), and every answer carries the client's HMAC over the
// request's nonce and what it says, so the hopper knows the client answered (design.md "Target
// authentication").
import { describe, expect, it } from 'vitest';
import { createNonceCache, signRequest, signResponse, verifyRequest, verifyResponse, mintToken, checkToken } from '../../src/client/signature.ts';

const TOKEN = mintToken();
const BODY = JSON.stringify({ args: ['status', 'server'] });
const T0 = 1_800_000_000_000;

describe('client token', () => {
  it('minted with 256 bits from the OS random source, base64url', () => {
    const t = mintToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mintToken()).not.toBe(t);
    expect(checkToken(t)).toBe(t);
  });

  it('a short or empty token is refused: it would be guessable', () => {
    expect(() => checkToken('')).toThrow(/at least 43/);
    expect(() => checkToken('short-token')).toThrow(/at least 43/);
  });
});

describe('a signed request', () => {
  it('verifies once, within the window', () => {
    const seen = createNonceCache();
    const h = signRequest(TOKEN, 'POST', '/herdr', BODY, T0);
    expect(h).toMatch(/^ts=\d+,nonce=[0-9a-f]{32},sig=[A-Za-z0-9_-]{43}$/);
    expect(h).not.toContain(TOKEN);
    const v = verifyRequest(TOKEN, h, 'POST', '/herdr', BODY, seen, T0 + 1000);
    expect(v).toMatchObject({ ok: true });
  });

  it('replayed: refused', () => {
    const seen = createNonceCache();
    const h = signRequest(TOKEN, 'POST', '/herdr', BODY, T0);
    expect(verifyRequest(TOKEN, h, 'POST', '/herdr', BODY, seen, T0)).toMatchObject({ ok: true });
    expect(verifyRequest(TOKEN, h, 'POST', '/herdr', BODY, seen, T0 + 10)).toEqual({ ok: false, why: 'replayed' });
  });

  it('outside the 30 s window, either way: refused', () => {
    const h = signRequest(TOKEN, 'POST', '/herdr', BODY, T0);
    expect(verifyRequest(TOKEN, h, 'POST', '/herdr', BODY, createNonceCache(), T0 + 30001)).toEqual({ ok: false, why: 'stale' });
    expect(verifyRequest(TOKEN, h, 'POST', '/herdr', BODY, createNonceCache(), T0 - 30001)).toEqual({ ok: false, why: 'stale' });
  });

  it('another token, body, path or method: refused', () => {
    const h = signRequest(TOKEN, 'POST', '/herdr', BODY, T0);
    const bad = { ok: false, why: 'bad signature' };
    expect(verifyRequest(mintToken(), h, 'POST', '/herdr', BODY, createNonceCache(), T0)).toEqual(bad);
    expect(verifyRequest(TOKEN, h, 'POST', '/herdr', JSON.stringify({ args: ['pane', 'close', 'w1:p1'] }), createNonceCache(), T0)).toEqual(bad);
    expect(verifyRequest(TOKEN, h, 'POST', '/other', BODY, createNonceCache(), T0)).toEqual(bad);
    expect(verifyRequest(TOKEN, h, 'GET', '/herdr', BODY, createNonceCache(), T0)).toEqual(bad);
  });

  it('missing or malformed: refused', () => {
    for (const h of [undefined, '', 'Bearer x', 'ts=1,nonce=zz,sig=a', `ts=${T0},nonce=${'a'.repeat(32)}`]) {
      expect(verifyRequest(TOKEN, h, 'POST', '/herdr', BODY, createNonceCache(), T0)).toEqual({ ok: false, why: 'unsigned' });
    }
  });
});

describe('a signed answer', () => {
  const nonce = 'ab'.repeat(16);
  it('verifies against the request\'s nonce, status and body', () => {
    const h = signResponse(TOKEN, nonce, 200, '{"code":0}');
    expect(verifyResponse(TOKEN, h, nonce, 200, '{"code":0}')).toBe(true);
  });

  it('another nonce, status, body or token, or none: not the client', () => {
    const h = signResponse(TOKEN, nonce, 200, '{"code":0}');
    expect(verifyResponse(TOKEN, h, 'cd'.repeat(16), 200, '{"code":0}')).toBe(false);
    expect(verifyResponse(TOKEN, h, nonce, 500, '{"code":0}')).toBe(false);
    expect(verifyResponse(TOKEN, h, nonce, 200, '{"code":1}')).toBe(false);
    expect(verifyResponse(mintToken(), h, nonce, 200, '{"code":0}')).toBe(false);
    expect(verifyResponse(TOKEN, undefined, nonce, 200, '{"code":0}')).toBe(false);
  });
});
