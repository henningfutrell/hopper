// Issue #59: the hopper proves itself to a client target with the client's token, over HTTP — and
// the token itself never crosses the wire: every request carries an HMAC of what it asks, fresh
// (a timestamp window) and once (a nonce), and every answer carries the client's HMAC over the
// request's nonce and what it says, so the hopper knows the client answered (design.md "Target
// authentication").
import { describe, expect, it } from 'vitest';
import { HELD_CREDIT_MS, WINDOW_MS, createNonceCache, signConnect, signLeave, signRequest, signResponse, signVault, verifyConnect, verifyLeave, verifyRequest, verifyResponse, verifyVault, mintToken, checkToken } from '../../src/client/signature.ts';

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

// Issue #1383: a dial-in that waited behind the hopper's held event loop is read late; the time the loop was held since
// it was signed is credited, at most HELD_CREDIT_MS. The nonce still holds it to once.
describe('a dial-in read after a held event loop', () => {
  const USER = 'u1', KEY = 'k'.repeat(43);
  it('is fresh for the time the loop was held since it was signed', () => {
    const h = signConnect(TOKEN, USER, KEY, T0);
    const held = (from: number) => (from === T0 ? 129_000 : 0);
    expect(verifyConnect(TOKEN, h, USER, KEY, createNonceCache(), T0 + 150_000)).toEqual({ ok: false, why: 'stale' });
    expect(verifyConnect(TOKEN, h, USER, KEY, createNonceCache(), T0 + 150_000, held)).toMatchObject({ ok: true });
    expect(verifyConnect(TOKEN, h, USER, KEY, createNonceCache(), T0 + 159_001, held)).toEqual({ ok: false, why: 'stale' });
  });

  it('is credited at most HELD_CREDIT_MS, and a dial-in from the future gets none', () => {
    const h = signConnect(TOKEN, USER, KEY, T0);
    const held = () => 60 * 60_000;
    expect(verifyConnect(TOKEN, h, USER, KEY, createNonceCache(), T0 + WINDOW_MS + HELD_CREDIT_MS, held)).toMatchObject({ ok: true });
    expect(verifyConnect(TOKEN, h, USER, KEY, createNonceCache(), T0 + WINDOW_MS + HELD_CREDIT_MS + 1, held)).toEqual({ ok: false, why: 'stale' });
    expect(verifyConnect(TOKEN, h, USER, KEY, createNonceCache(), T0 - WINDOW_MS - 1, held)).toEqual({ ok: false, why: 'stale' });
  });

  it('a vault ask and a leave are credited the same way', () => {
    const held = () => 100_000;
    expect(verifyVault(TOKEN, signVault(TOKEN, USER, KEY, BODY, T0), USER, KEY, BODY, createNonceCache(), T0 + 120_000, held)).toMatchObject({ ok: true });
    expect(verifyLeave(TOKEN, signLeave(TOKEN, USER, KEY, T0), USER, KEY, createNonceCache(), T0 + 120_000, held)).toMatchObject({ ok: true });
  });

  it('is still accepted once', () => {
    const h = signConnect(TOKEN, USER, KEY, T0), seen = createNonceCache(WINDOW_MS + HELD_CREDIT_MS);
    expect(verifyConnect(TOKEN, h, USER, KEY, seen, T0 + 100_000, () => 90_000)).toMatchObject({ ok: true });
    expect(verifyConnect(TOKEN, h, USER, KEY, seen, T0 + 200_000, () => 190_000)).toEqual({ ok: false, why: 'replayed' });
  });
});
