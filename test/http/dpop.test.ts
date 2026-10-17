// DPoP proofs (RFC 9449, issue #892 "Sender binding", design.md "Sender binding"): a proof is a JWT the agent signs with
// its own key for one request. The hopper reads the key's thumbprint from a proof that names this request (method, URL,
// a fresh `iat`, a `jti` not seen before, the API token's hash), and refuses any other. Only the clock is the test's.
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { DPOP } from '../../src/domain/types.ts';
import { createDpopProofs, type DpopProofs } from '../../src/http/ui/dpop.ts';
import { dpopKey, type DpopKey } from '../support/dpop.ts';
import { fixedClock } from '../store/helpers.ts';

const clock = fixedClock();
const T = Date.parse('2026-10-17T10:00:00.000Z');
const iat = T / 1000;
const URL_ = 'http://127.0.0.1:4800/ui/auth/token/refresh';
let proofs: DpopProofs;
let key: DpopKey;

const request = (proof: string | string[] | undefined, o: { method?: string; url?: string; host?: string } = {}) => ({
  method: o.method ?? 'POST', url: o.url ?? '/ui/auth/token/refresh', headers: { host: o.host ?? '127.0.0.1:4800', ...(proof === undefined ? {} : { dpop: proof }) },
});

const passes = async (proof: string, o?: Parameters<typeof request>[1]): Promise<boolean> => (await proofs.check(request(proof, o))).ok;

beforeEach(async () => {
  clock.set(new Date(T).toISOString());
  proofs = createDpopProofs({ clock });
  key = await dpopKey();
});

describe('a DPoP proof (issue #892)', () => {
  it('names the key it is signed with: its JWK SHA-256 thumbprint', async () => {
    expect(await proofs.check(request(await key.proof('POST', URL_, { iat })))).toEqual({ ok: true, jkt: key.jkt });
    const ed = await dpopKey('EdDSA');
    expect(await proofs.check(request(await ed.proof('POST', URL_, { iat })))).toEqual({ ok: true, jkt: ed.jkt });
  });

  it('no proof: no key, and no refusal', async () => {
    expect(await proofs.check(request(undefined))).toEqual({ ok: true });
  });

  it('a query in the request or in htu does not count; https names the same request behind a proxy', async () => {
    expect(await passes(await key.proof('POST', `${URL_}?x=1`, { iat }), { url: '/ui/auth/token/refresh?y=2' })).toBe(true);
    expect(await passes(await key.proof('POST', 'https://127.0.0.1:4800/ui/auth/token/refresh', { iat }))).toBe(true);
  });

  it('is refused for another method, path or host', async () => {
    for (const [proof, why] of [
      [await key.proof('GET', URL_, { iat }), /htm/],
      [await key.proof('POST', 'http://127.0.0.1:4800/ui/auth/api-token', { iat }), /htu/],
      [await key.proof('POST', 'http://other.example:4800/ui/auth/token/refresh', { iat }), /htu/],
      [await key.proof('POST', 'ftp://127.0.0.1:4800/ui/auth/token/refresh', { iat }), /htu/],
      [await key.proof('POST', 'not a url', { iat }), /htu/],
    ] as const) {
      const r = await proofs.check(request(proof));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    }
  });

  it(`is refused when its iat is more than ${DPOP.maxAgeS} seconds off the hopper's clock`, async () => {
    expect(await passes(await key.proof('POST', URL_, { iat: iat - DPOP.maxAgeS }))).toBe(true);
    expect(await passes(await key.proof('POST', URL_, { iat: iat + DPOP.maxAgeS }))).toBe(true);
    for (const at of [iat - DPOP.maxAgeS - 1, iat + DPOP.maxAgeS + 1]) {
      const r = await proofs.check(request(await key.proof('POST', URL_, { iat: at })));
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/iat/) });
    }
  });

  it('is good once: a jti seen before is refused while the proof could still be fresh', async () => {
    const proof = await key.proof('POST', URL_, { iat, jti: 'one' });
    expect(await passes(proof)).toBe(true);
    expect(await proofs.check(request(proof))).toMatchObject({ ok: false, error: expect.stringMatching(/jti/) });
    // Another key may use the same jti: it is its own.
    const other = await dpopKey();
    expect(await passes(await other.proof('POST', URL_, { iat, jti: 'one' }))).toBe(true);
    // Once a proof with it would be stale, the jti is forgotten.
    clock.set(new Date(T + (2 * DPOP.maxAgeS + 1) * 1000).toISOString());
    const later = (T / 1000) + 2 * DPOP.maxAgeS + 1;
    expect(await passes(await key.proof('POST', URL_, { iat: later, jti: 'one' }))).toBe(true);
  });

  it('goes with an API token: ath must be the token\'s SHA-256', async () => {
    const token = `hopper_at_${'a'.repeat(64)}`;
    const get = (proof: string) => ({ method: 'GET', url: '/api/queue', headers: { host: '127.0.0.1:4800', dpop: proof } });
    const at = 'http://127.0.0.1:4800/api/queue';
    expect(await proofs.check(get(await key.proof('GET', at, { iat, token })), token)).toEqual({ ok: true, jkt: key.jkt });
    expect(await proofs.check(get(await key.proof('GET', at, { iat })), token)).toMatchObject({ ok: false, error: expect.stringMatching(/ath/) });
    expect(await proofs.check(get(await key.proof('GET', at, { iat, token: `hopper_at_${'b'.repeat(64)}` })), token)).toMatchObject({ ok: false, error: expect.stringMatching(/ath/) });
  });

  it('is refused when it is no DPoP proof: another typ, a symmetric or no algorithm, a private key, no jwk, two headers', async () => {
    const bad: (string | string[])[] = [
      await key.proof('POST', URL_, { iat, header: { typ: 'JWT' } }),
      'not.a.jwt',
      [await key.proof('POST', URL_, { iat }), await key.proof('POST', URL_, { iat })],
      await key.proof('POST', URL_, { iat, claims: { jti: undefined } }),
    ];
    const pair = await generateKeyPair('ES256', { extractable: true });
    const priv = await exportJWK(pair.privateKey);
    bad.push(await new SignJWT({ htm: 'POST', htu: URL_, jti: 'p', iat }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: priv }).sign(pair.privateKey));
    bad.push(await new SignJWT({ htm: 'POST', htu: URL_, jti: 'h', iat }).setProtectedHeader({ alg: 'HS256', typ: 'dpop+jwt' }).sign(new Uint8Array(32)));
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'dpop+jwt', jwk: key.jwk })).toString('base64url')}.${Buffer.from(JSON.stringify({ htm: 'POST', htu: URL_, jti: 'n', iat })).toString('base64url')}.`;
    bad.push(unsigned);
    for (const proof of bad) {
      const r = await proofs.check(request(proof));
      expect(r.ok, String(proof)).toBe(false);
    }
  });

  it(`keeps at most ${DPOP.jtiMost} jti at once: beyond, a proof is refused until one is forgotten`, async () => {
    const small = createDpopProofs({ clock, most: 2 });
    expect((await small.check(request(await key.proof('POST', URL_, { iat, jti: 'a' })))).ok).toBe(true);
    expect((await small.check(request(await key.proof('POST', URL_, { iat, jti: 'b' })))).ok).toBe(true);
    expect(await small.check(request(await key.proof('POST', URL_, { iat, jti: 'c' })))).toMatchObject({ ok: false, error: expect.stringMatching(/too many/) });
  });
});

describe('a thumbprint', () => {
  it('is 43 base64url characters', async () => {
    const { JKT } = await import('../../src/domain/types.ts');
    expect(JKT.test(key.jkt)).toBe(true);
    expect(JKT.test('short')).toBe(false);
  });
});
