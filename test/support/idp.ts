// Identity providers for sign-in tests, all on loopback: an OIDC issuer (oauth2-mock-server), a
// GitHub OAuth fake, and a SAML IdP that signs responses with a throwaway key (openssl). Plus
// `signIn`, which drives a whole browser sign-in through the daemon's HTTP routes.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { OAuth2Server } from 'oauth2-mock-server';
import { SignedXml } from 'xml-crypto';
import { rawRequest, type RawResponse } from './http.ts';

// ---- OIDC ----------------------------------------------------------------------------------

export interface OidcIdp {
  issuer: string; claims: Record<string, unknown>; userinfo: Record<string, unknown>;
  /** A JWT the issuer signs (as a gateway in front of the hopper would forward it), with these claims. */
  token(claims: Record<string, unknown>, expiresIn: number): Promise<string>;
  /** Answer token introspection: `answer` fills the response body; `authorization` is the request's header. */
  onIntrospect(answer: (body: Record<string, unknown>, authorization: string) => void): void;
  stop(): Promise<void>;
}

/** An OIDC issuer. Every ID token carries `claims` (sub stays `johndoe`); userinfo answers `userinfo`. */
export async function startOidcIdp(): Promise<OidcIdp> {
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');
  await server.start(0, '127.0.0.1');
  const idp: OidcIdp = {
    issuer: server.issuer.url!, claims: {}, userinfo: {}, stop: () => server.stop(),
    token: (claims, expiresIn) => server.issuer.buildToken({ expiresIn, scopesOrTransform: (_header, payload) => { Object.assign(payload, claims); } }),
    onIntrospect: (answer) => {
      server.service.on('beforeIntrospect', (res: { body: Record<string, unknown> }, req: { headers: Record<string, string | undefined> }) => {
        answer(res.body, req.headers.authorization ?? '');
      });
    },
  };
  server.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => { Object.assign(token.payload, idp.claims); });
  server.service.on('beforeUserinfo', (res: { body: Record<string, unknown> }) => { Object.assign(res.body, idp.userinfo); });
  return idp;
}

// ---- GitHub --------------------------------------------------------------------------------

export interface GithubFake {
  url: string;
  user: { id: number; login: string; name: string | null };
  emails: { email: string; primary: boolean; verified: boolean }[];
  teams: { slug: string; organization: { login: string } }[];
  /** The scope of the last authorize request. */
  lastScope?: string;
  stop(): Promise<void>;
}

/** GitHub's OAuth web flow and the three REST reads, web and API on one loopback server. */
export async function startGithubFake(): Promise<GithubFake> {
  const codes = new Map<string, string>(); // code → code_challenge
  const token = randomBytes(16).toString('hex');
  const fake = {
    url: '', user: { id: 4242, login: 'octo', name: 'Octo Cat' },
    emails: [{ email: 'octo@example.com', primary: true, verified: true }], teams: [] as GithubFake['teams'],
  } as GithubFake;
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/login/oauth/authorize') {
      fake.lastScope = u.searchParams.get('scope') ?? '';
      const code = randomBytes(8).toString('hex');
      codes.set(code, u.searchParams.get('code_challenge') ?? '');
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state')!);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (u.pathname === '/login/oauth/access_token') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const challenge = codes.get(p.get('code') ?? '');
        const verifier = p.get('code_verifier') ?? '';
        if (challenge === undefined || createHash('sha256').update(verifier).digest('base64url') !== challenge || p.get('client_secret') !== 'gh-secret') {
          json(200, { error: 'bad_verification_code' });
          return;
        }
        codes.delete(p.get('code')!);
        json(200, { access_token: token, token_type: 'bearer', scope: fake.lastScope });
      });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) { json(401, { message: 'Bad credentials' }); return; }
    if (u.pathname === '/user') { json(200, fake.user); return; }
    if (u.pathname === '/user/emails') { json(200, fake.emails); return; }
    if (u.pathname === '/user/teams') { json(200, fake.teams); return; }
    json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.stop = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return fake;
}

// ---- SAML ----------------------------------------------------------------------------------

export interface SamlIdp {
  entryPoint: string;
  issuer: string;
  cert: string;
  /** The IdP's form post for the AuthnRequest in `authorizeUrl`. */
  respond(authorizeUrl: string, o: { nameID: string; attributes?: Record<string, string | string[]>; signedWith?: 'idp' | 'other'; tamper?: (xml: string) => string }): Record<string, string>;
  stop(): void;
}

function keyPair(dir: string, name: string): { key: string; cert: string } {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`),
    '-days', '1', '-subj', `/CN=${name}`], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, `${name}.key`), 'utf8'), cert: readFileSync(join(dir, `${name}.crt`), 'utf8') };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function startSamlIdp(): SamlIdp {
  const dir = mkdtempSync(join(tmpdir(), 'jh-saml-idp-'));
  const idp = keyPair(dir, 'test-idp');
  const other = keyPair(dir, 'other-idp');
  const issuer = 'https://idp.test/saml';
  return {
    entryPoint: 'https://idp.test/saml/sso', issuer, cert: idp.cert,
    respond(authorizeUrl, o) {
      const u = new URL(authorizeUrl);
      const request = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
      const requestId = /\sID="([^"]+)"/.exec(request)![1]!;
      const acs = /AssertionConsumerServiceURL="([^"]+)"/.exec(request)![1]!;
      const audience = /<saml:Issuer[^>]*>([^<]+)<\/saml:Issuer>/.exec(request)![1]!;
      const now = new Date();
      const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
      const attrs = Object.entries(o.attributes ?? {}).map(([k, v]) => `<saml:Attribute Name="${esc(k)}">${
        (Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');
      const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${at(0)}" Destination="${acs}" InResponseTo="${requestId}">`
        + `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
        + `<saml:Assertion ID="_a${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${at(0)}"><saml:Issuer>${issuer}</saml:Issuer>`
        + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${esc(o.nameID)}</saml:NameID>`
        + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" NotOnOrAfter="${at(300_000)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject>`
        + `<saml:Conditions NotBefore="${at(-60_000)}" NotOnOrAfter="${at(300_000)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
        + `<saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
        + `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
      const signer = o.signedWith === 'other' ? other : idp;
      const sig = new SignedXml({
        privateKey: signer.key, publicCert: signer.cert,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      sig.addReference({
        xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      });
      sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      const signed = (o.tamper ?? ((x) => x))(sig.getSignedXml());
      return { SAMLResponse: Buffer.from(signed, 'utf8').toString('base64'), RelayState: u.searchParams.get('RelayState')! };
    },
    stop: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---- Driving a browser sign-in ---------------------------------------------------------------

export const TICKET_RE = /ticket:\s*'([0-9a-f]{64})'/;

export interface SignInRun {
  /** The 302 from /ui/auth/<name>/start. */
  start: RawResponse;
  /** The daemon's answer to the provider's callback. */
  callback?: RawResponse;
  /** POST /ui/auth/complete, when the callback carried a ticket. */
  complete?: RawResponse;
  /** The session token, when sign-in worked. */
  token?: string;
}

/**
 * One sign-in as a browser on the sign-in origin does it. `saml` answers the AuthnRequest (the
 * IdP's form post); otherwise the provider's redirect is followed. `binding` is the one the browser
 * kept; `completeBinding` what it posts at the end (another browser's, to test the binding).
 */
export async function signIn(base: string, origin: string, name: string, o: {
  saml?: (authorizeUrl: string) => Record<string, string>; binding?: string; completeBinding?: string;
} = {}): Promise<SignInRun> {
  const host = new URL(origin).host;
  const binding = o.binding ?? randomBytes(24).toString('base64url');
  const start = await rawRequest(base, { path: `/ui/auth/${name}/start?binding=${binding}`, headers: { host } });
  if (start.status !== 302) return { start };
  const location = String(start.headers.location);
  let callback: RawResponse;
  if (o.saml) {
    const form = new URLSearchParams(o.saml(location)).toString();
    callback = await rawRequest(base, { method: 'POST', path: `/ui/auth/${name}/callback`, body: form,
      headers: { host, origin: 'https://idp.test', 'content-type': 'application/x-www-form-urlencoded' } });
  } else {
    const atIdp = await fetch(location, { redirect: 'manual' });
    const back = new URL(atIdp.headers.get('location')!);
    callback = await rawRequest(base, { path: back.pathname + back.search, headers: { host } });
  }
  const ticket = TICKET_RE.exec(callback.text)?.[1];
  if (!ticket) return { start, callback };
  const complete = await rawRequest(base, { method: 'POST', path: '/ui/auth/complete', body: JSON.stringify({ ticket, binding: o.completeBinding ?? binding }),
    headers: { host, origin, 'content-type': 'application/json' } });
  const token = complete.status === 200 ? (JSON.parse(complete.text) as { token: string }).token : undefined;
  return { start, callback, complete, ...(token ? { token } : {}) };
}
