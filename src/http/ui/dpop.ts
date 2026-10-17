// DPoP proofs (issue #892, design.md "Sender binding"), on the model of RFC 9449: an agent signs a short JWT with a key of
// its own for each request, and a grant bound to that key is good only with such a proof. So a stolen refresh token, API
// token or device code alone is not enough: the thief needs the agent's private key too. This reads the proof the request
// carries in its `DPoP` header and answers the thumbprint of the key it is signed with (RFC 7638), or why it is no proof
// of this request. Which key a grant is bound to, and when a proof is needed, is the caller's (./api-grants.ts, ./api-tokens.ts,
// ../tenants.ts).
//
// The signature, the `typ`, the algorithm and the embedded public key are jose's (EmbeddedJWK, jwtVerify); what RFC 9449
// §4.3 adds is checked here: `htm` and `htu` name this request, `iat` is fresh, `jti` was not seen, and `ath` is the API
// token's hash. Not built: the server nonce (`DPoP-Nonce`, RFC 9449 §8); the `iat` window and the `jti` cache stand for it.
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { EmbeddedJWK, calculateJwkThumbprint, jwtVerify, type JWK } from 'jose';
import type { Clock } from '../../domain/ports.ts';
import { DPOP } from '../../domain/types.ts';

/** What a request's proof names: the key's thumbprint; none when the request carries no proof. */
export type ProofAnswer = { ok: true; jkt?: string } | { ok: false; error: string };

/** The request as a proof is checked against: its method, its path (a query does not count), and its Host. */
export interface ProofRequest { method: string; url: string; headers: IncomingHttpHeaders }

export interface DpopProofs {
  /** The key of the request's proof, or why it is none. `accessToken`: the API token the proof goes with (its `ath`). */
  check(req: ProofRequest, accessToken?: string): Promise<ProofAnswer>;
}

const pathOf = (url: string): string => new URL(url, 'http://h').pathname;

export function createDpopProofs(o: { clock: Clock; most?: number }): DpopProofs {
  const most = o.most ?? DPOP.jtiMost;
  /** The `jti` seen, by key and jti, with when a proof with it would be stale. */
  const seen = new Map<string, number>();
  const nowS = (): number => o.clock.now().getTime() / 1000;
  const forget = (): void => {
    for (const [k, until] of seen) if (nowS() > until) seen.delete(k);
  };

  return {
    async check(req, accessToken) {
      const header = req.headers.dpop;
      if (header === undefined) return { ok: true };
      if (typeof header !== 'string') return { ok: false, error: 'the request carries more than one DPoP header' };
      let payload: Record<string, unknown>;
      let jwk: JWK;
      try {
        const v = await jwtVerify(header, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: [...DPOP.algorithms], currentDate: o.clock.now(), requiredClaims: ['iat', 'jti', 'htm', 'htu'] });
        payload = v.payload;
        jwk = v.protectedHeader.jwk as JWK;
      } catch (e) {
        return { ok: false, error: `the DPoP proof is no valid proof: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (payload.htm !== req.method) return { ok: false, error: `the DPoP proof's htm is not ${req.method}` };
      let htu: URL | undefined;
      try { htu = typeof payload.htu === 'string' ? new URL(payload.htu) : undefined; } catch { htu = undefined; }
      // Behind a proxy or the tunnel the request reached the hopper as http: either scheme names it.
      if (!htu || !['http:', 'https:'].includes(htu.protocol) || htu.host !== (req.headers.host ?? '').toLowerCase() || htu.pathname !== pathOf(req.url)) {
        return { ok: false, error: 'the DPoP proof\'s htu is not the URL of this request' };
      }
      const iat = Number(payload.iat);
      if (!Number.isFinite(iat) || Math.abs(nowS() - iat) > DPOP.maxAgeS) return { ok: false, error: `the DPoP proof's iat is more than ${DPOP.maxAgeS} seconds off the hopper's clock` };
      if (accessToken !== undefined && payload.ath !== createHash('sha256').update(accessToken, 'ascii').digest('base64url')) {
        return { ok: false, error: 'the DPoP proof\'s ath is not the hash of the API token it is sent with' };
      }
      const jkt = await calculateJwkThumbprint(jwk, 'sha256');
      const key = `${jkt} ${String(payload.jti)}`;
      forget();
      if (seen.has(key)) return { ok: false, error: 'the DPoP proof\'s jti was used before: make a new proof for each request' };
      if (seen.size >= most) return { ok: false, error: 'too many DPoP proofs are kept: try again in a minute' };
      seen.set(key, iat + DPOP.maxAgeS);
      return { ok: true, jkt };
    },
  };
}
