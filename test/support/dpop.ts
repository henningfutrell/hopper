// An agent's DPoP key (RFC 9449, issue #892 "Sender binding"), as a test makes one: its public JWK, its thumbprint, and
// proofs signed with it for a request. `iat` defaults to the real time; a test on a fixed clock names it.
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface ProofOptions {
  /** The API token the proof goes with: its `ath`. */
  token?: string;
  /** Seconds since the epoch; default: now. */
  iat?: number;
  jti?: string;
  /** Claims that replace the proof's own. */
  claims?: Record<string, unknown>;
  /** Header parameters that replace the proof's own. */
  header?: Record<string, unknown>;
}

export interface DpopKey { jkt: string; jwk: JWK; proof(method: string, url: string, o?: ProofOptions): Promise<string> }

export async function dpopKey(alg: 'ES256' | 'EdDSA' | 'RS256' = 'ES256'): Promise<DpopKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(jwk, 'sha256');
  return {
    jkt, jwk,
    proof: (method, url, o = {}) => new SignJWT({
      htm: method, htu: url, jti: o.jti ?? randomUUID(), iat: o.iat ?? Math.floor(Date.now() / 1000),
      ...(o.token === undefined ? {} : { ath: createHash('sha256').update(o.token, 'ascii').digest('base64url') }), ...o.claims,
    }).setProtectedHeader({ alg, typ: 'dpop+jwt', jwk, ...o.header } as never).sign(privateKey),
  };
}
