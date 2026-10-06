// The gateway realm (issue #215): the hopper behind an auth gateway (Envoy Gateway with OIDC, oauth2-proxy,
// …). The gateway signs people in and forwards their token on every request; the hopper signs nobody in
// here, it only checks that token. Two checks, each through an established library:
//   jwt            — jose: the signature against the issuer's keys (JWKS), `iss`, `aud`, `exp`, `nbf`.
//   introspection  — openid-client: RFC 7662 at the issuer's introspection endpoint, as the hopper's client.
// The issuer's discovery document (openid-client) names the keys and the endpoint; it is read on first use,
// not at boot, and retried after a failure, as the oidc realm does.
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as client from 'openid-client';
import type { GatewayRealmConfig } from './config.ts';
import { claimsIdentity, isLoopbackHttp, stringList, type GatewayOutcome, type GatewayRealm } from './realm.ts';

/** Seconds of clock difference between the issuer and the hopper a token's times may carry. */
const CLOCK_TOLERANCE = 30;
const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** The token in the forwarded header: `Bearer <token>` in `authorization`, the whole value in any other. */
export function tokenIn(headers: Record<string, string | string[] | undefined>, header: string): string | undefined {
  const v = headers[header];
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return header === 'authorization' ? BEARER.exec(v)?.[1] : v.trim();
}

/** A token the library refuses, as opposed to an issuer it could not reach. */
const isRefusal = (e: unknown): e is errors.JOSEError =>
  e instanceof errors.JOSEError && !(e instanceof errors.JWKSTimeout) && e.code !== 'ERR_JOSE_GENERIC';

export function createGatewayRealm(c: GatewayRealmConfig): GatewayRealm {
  let discovered: Promise<client.Configuration> | undefined;
  let keys: JWTVerifyGetKey | undefined;
  const config = (): Promise<client.Configuration> => {
    discovered ??= client.discovery(new URL(c.issuer), c.clientId ?? c.name,
      c.clientSecret === undefined ? undefined : { client_secret: c.clientSecret },
      c.clientSecret === undefined ? undefined : client.ClientSecretBasic(c.clientSecret),
      isLoopbackHttp(c.issuer) ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((e: unknown) => { discovered = undefined; throw new Error(`discovery at ${c.issuer} failed: ${(e as Error).message}`); });
    return discovered;
  };

  async function viaJwt(token: string, cfg: client.Configuration): Promise<GatewayOutcome> {
    const meta = cfg.serverMetadata();
    if (!meta.jwks_uri) return { ok: false, error: `${c.issuer} names no jwks_uri` };
    keys ??= createRemoteJWKSet(new URL(meta.jwks_uri));
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: meta.issuer, audience: c.audience!, clockTolerance: CLOCK_TOLERANCE });
      if (!payload.sub) return { ok: false, refused: 'the token names no subject (sub)' };
      return { ok: true, who: claimsIdentity(c.name, payload.sub, payload, c.claims, c.trustUnverifiedEmail) };
    } catch (e) {
      if (isRefusal(e)) return { ok: false, refused: `token refused: ${e.message}` };
      return { ok: false, error: `the issuer's keys could not be read: ${(e as Error).message}` };
    }
  }

  async function viaIntrospection(token: string, cfg: client.Configuration): Promise<GatewayOutcome> {
    let answer: client.IntrospectionResponse;
    try {
      answer = await client.tokenIntrospection(cfg, token);
    } catch (e) {
      return { ok: false, error: `token introspection failed: ${(e as Error).message}` };
    }
    if (answer.active !== true) return { ok: false, refused: 'the token is not active' };
    if (c.audience?.length && !stringList(answer.aud).some((a) => c.audience!.includes(a))) return { ok: false, refused: 'the token is for another audience' };
    if (!answer.sub) return { ok: false, refused: 'the token names no subject (sub)' };
    return { ok: true, who: claimsIdentity(c.name, answer.sub, answer, c.claims, c.trustUnverifiedEmail) };
  }

  return {
    name: c.name, label: c.label,
    async check(headers) {
      const token = tokenIn(headers, c.header);
      if (token === undefined) return { ok: false, refused: `no token in ${c.header}` };
      let cfg: client.Configuration;
      try {
        cfg = await config();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      return c.check === 'jwt' ? viaJwt(token, cfg) : viaIntrospection(token, cfg);
    },
  };
}
