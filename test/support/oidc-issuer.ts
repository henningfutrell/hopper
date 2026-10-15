// An OIDC issuer on loopback whose keys the test holds (issue #1380): which key signs the ID token, which keys
// the JWKS publishes, and what the ID token claims, so a test can sign with a key the issuer never published,
// change `iss` or `aud`, and rotate or remove keys. Discovery, authorize (a code straight back), token and JWKS;
// no userinfo, so the ID token is all the realm reads. Its clock is Date.now(), so a test's fake clock moves both.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

export interface IssuerKey { kid: string; privateKey: CryptoKey; jwk: JWK }

export interface TestIssuer {
  issuer: string;
  /** Signs the next ID tokens. */
  signWith: IssuerKey;
  /** What the JWKS answers, in order. */
  published: IssuerKey[];
  /** Changes the next ID token's claims (after `iss`, `aud`, `sub`, `nonce`, the times and `email`). */
  claims: Record<string, unknown>;
  /** How many times the JWKS was read. */
  jwksReads: number;
  /** A new RS256 key; not published until the test adds it to `published`. */
  newKey(): Promise<IssuerKey>;
  stop(): Promise<void>;
}

export async function newIssuerKey(): Promise<IssuerKey> {
  const kid = randomBytes(8).toString('hex');
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

export async function startTestIssuer(clientId: string): Promise<TestIssuer> {
  const nonces = new Map<string, string>();
  const first = await newIssuerKey();
  let server: Server | undefined;
  const t: TestIssuer = {
    issuer: '', signWith: first, published: [first], claims: {}, jwksReads: 0,
    newKey: newIssuerKey,
    stop: () => new Promise((done) => { server?.close(() => done()); }),
  };
  const json = (res: import('node:http').ServerResponse, body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', t.issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      json(res, {
        issuer: t.issuer, authorization_endpoint: `${t.issuer}/authorize`, token_endpoint: `${t.issuer}/token`, jwks_uri: `${t.issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      });
    } else if (url.pathname === '/authorize') {
      const code = randomBytes(16).toString('hex');
      nonces.set(code, url.searchParams.get('nonce') ?? '');
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.href }).end();
    } else if (url.pathname === '/jwks') {
      t.jwksReads++;
      json(res, { keys: t.published.map((k) => k.jwk) });
    } else if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        const nonce = nonces.get(code);
        nonces.delete(code);
        if (nonce === undefined) { res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}'); return; }
        const now = Math.floor(Date.now() / 1000);
        void new SignJWT({ iss: t.issuer, aud: clientId, sub: 'ada-1', nonce, iat: now, exp: now + 300, email: 'ada@example.com', email_verified: true, ...t.claims })
          .setProtectedHeader({ alg: 'RS256', kid: t.signWith.kid, typ: 'JWT' })
          .sign(t.signWith.privateKey)
          .then((idToken) => { json(res, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken }); });
      });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', done); });
  t.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return t;
}
