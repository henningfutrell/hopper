// The policy-assert proxy (issue #1956): an HTTP proxy in front of a mock AWS (moto) that re-checks every SigV4 request
// against the session policy of the credentials that signed it, as AWS would, and logs each allow and deny. moto itself
// enforces no policy, so this is what makes a read session's scope real in the acceptance tests.
//
// It learns each session from the STS AssumeRole calls that pass through it: the role, the session name, the duration,
// the session policies (managed ARNs and the inline policy) and the expiry moto answered. A call is then allowed only
// when (1) it is signed, (2) by a key the proxy knows (an admin key given at start, or a session it saw minted), (3)
// whose session has not expired or been revoked, and (4) no Deny statement of the session's policies matches it and,
// when the session has session policies, one of them allows it. The role's own policy is taken as allowing everything:
// the acceptance seed gives its roles full access, so whatever a session cannot do is the session policy's doing.
//
// `ReadOnlyAccess` is modelled by IAM's access levels (`@cloud-copilot/iam-data`): the actions of level Read and List.
// Any other managed policy allows nothing. A call the proxy cannot name, a resource it cannot name under a Deny with a
// resource, and a Deny with a condition all count against the call: the proxy fails closed.
//
// What it does not do: verify the signature itself (a forged signature with a known key gets that key's rights, no
// more), or model a role's own policy, permission boundaries or resource policies.
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { iamActionDetails } from '@cloud-copilot/iam-data';
import { loadPolicy, type Statement } from '@cloud-copilot/iam-policy';

export const READ_ONLY_ACCESS = 'arn:aws:iam::aws:policy/ReadOnlyAccess';

export interface Session {
  accessKeyId: string;
  roleArn: string;
  sessionName: string;
  durationSeconds: number;
  policyArns: string[];
  policy?: string;
  expiration: string;
  revoked?: boolean;
}

/** What a request asks for: the IAM action, and the resource when the proxy can name it. */
export interface Call { service: string; action: string; resource?: string }

export interface Decision {
  at: string;
  method: string;
  path: string;
  accessKeyId?: string;
  action?: string;
  resource?: string;
  allowed: boolean;
  reason: string;
}

export interface Request { method: string; url: string; headers: IncomingHttpHeaders; body: string }

const header = (h: IncomingHttpHeaders, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** The signing key and service of a SigV4 request: its Authorization header, or a presigned URL's query. */
export function signer(r: Request): { accessKeyId: string; service: string } | undefined {
  const auth = header(r.headers, 'authorization');
  const scope = auth ? /Credential=([^/,\s]+)\/\d{8}\/[^/]+\/([^/]+)\/aws4_request/.exec(auth) : undefined;
  if (scope) return { accessKeyId: scope[1]!, service: scope[2]! };
  const q = new URL(r.url, 'http://x').searchParams.get('X-Amz-Credential');
  const parts = q?.split('/');
  return parts && parts.length === 5 ? { accessKeyId: parts[0]!, service: parts[3]! } : undefined;
}

/** The parameters of a query-protocol call: its form body, else its URL query. */
const queryParams = (r: Request): URLSearchParams =>
  (header(r.headers, 'content-type') ?? '').includes('x-www-form-urlencoded') ? new URLSearchParams(r.body) : new URL(r.url, 'http://x').searchParams;

const S3_BUCKET_GET: Record<string, string> = { location: 'GetBucketLocation', versioning: 'GetBucketVersioning', acl: 'GetBucketAcl', policy: 'GetBucketPolicy', tagging: 'GetBucketTagging', versions: 'ListBucketVersions', uploads: 'ListBucketMultipartUploads', encryption: 'GetEncryptionConfiguration' };
const S3_BUCKET_PUT: Record<string, string> = { policy: 'PutBucketPolicy', acl: 'PutBucketAcl', tagging: 'PutBucketTagging', versioning: 'PutBucketVersioning', encryption: 'PutEncryptionConfiguration' };

/** An S3 REST call, path-style (the style an SDK uses for an endpoint that is an address), as its IAM action. */
function s3Call(r: Request): Call | undefined {
  const url = new URL(r.url, 'http://x');
  const [bucket = '', ...rest] = url.pathname.slice(1).split('/');
  const key = decodeURIComponent(rest.join('/'));
  const sub = [...url.searchParams.keys()];
  const has = (k: string): boolean => sub.includes(k);
  const resource = bucket ? `arn:aws:s3:::${bucket}${key ? `/${key}` : ''}` : '*';
  const call = (action: string | undefined): Call | undefined => (action ? { service: 's3', action, resource } : undefined);
  const method = r.method.toUpperCase();
  if (!bucket) return method === 'GET' ? call('ListAllMyBuckets') : undefined;
  if (!key) {
    const named = sub.find((k) => k in S3_BUCKET_GET || k in S3_BUCKET_PUT);
    if (method === 'GET' || method === 'HEAD') return call(named ? S3_BUCKET_GET[named] : 'ListBucket');
    if (method === 'PUT') return call(named ? S3_BUCKET_PUT[named] : 'CreateBucket');
    if (method === 'DELETE') return call(has('policy') ? 'DeleteBucketPolicy' : has('tagging') ? 'PutBucketTagging' : 'DeleteBucket');
    if (method === 'POST' && has('delete')) return call('DeleteObject');
    return undefined;
  }
  if (method === 'GET' || method === 'HEAD') return call(has('acl') ? 'GetObjectAcl' : has('tagging') ? 'GetObjectTagging' : has('versionId') ? 'GetObjectVersion' : 'GetObject');
  if (method === 'PUT') return call(has('acl') ? 'PutObjectAcl' : has('tagging') ? 'PutObjectTagging' : 'PutObject');
  if (method === 'DELETE') return call(has('versionId') ? 'DeleteObjectVersion' : 'DeleteObject');
  if (method === 'POST' && (has('uploads') || has('uploadId'))) return call('PutObject');
  return undefined;
}

/** An EKS REST call (the API topology discovery lists and describes clusters with) as its IAM action. */
function eksCall(r: Request): Call | undefined {
  const parts = new URL(r.url, 'http://x').pathname.split('/').filter(Boolean);
  if (parts[0] !== 'clusters' || parts.length > 2) return undefined;
  const method = r.method.toUpperCase();
  const action = parts.length === 1 ? (method === 'GET' ? 'ListClusters' : method === 'POST' ? 'CreateCluster' : undefined)
    : method === 'GET' ? 'DescribeCluster' : method === 'DELETE' ? 'DeleteCluster' : undefined;
  return action ? { service: 'eks', action } : undefined;
}

/** The IAM action of a request (and its resource where the proxy names one), or undefined when it cannot be named. */
export function callOf(r: Request): Call | undefined {
  const signed = signer(r);
  if (!signed) return undefined;
  const { service } = signed;
  const target = header(r.headers, 'x-amz-target');
  if (target) return { service, action: target.slice(target.lastIndexOf('.') + 1) };
  if (service === 's3') return s3Call(r);
  if (service === 'eks') return eksCall(r);
  const params = queryParams(r);
  const action = params.get('Action');
  if (!action) return undefined;
  const roleArn = params.get('RoleArn');
  return { service, action, ...(service === 'sts' && roleArn ? { resource: roleArn } : {}) };
}

/** Whether an IAM pattern (`*` and `?`, case-insensitive for actions) matches `value`. */
const matches = (pattern: string, value: string, caseless: boolean): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, caseless ? 'i' : '').test(value);

/** Whether a statement covers the call. `failClosed`: what is unknown (a resource, a condition) counts as covered. */
function covers(s: Statement, call: Call, failClosed: boolean): boolean {
  const action = `${call.service}:${call.action}`;
  const actionHit = s.isActionStatement() ? s.actions().some((a) => matches(a.value(), action, true))
    : s.isNotActionStatement() ? !s.notActions().some((a) => matches(a.value(), action, true)) : false;
  if (!actionHit) return false;
  let resourceHit: boolean;
  if (s.isResourceStatement()) {
    resourceHit = s.resources().some((x) => x.value() === '*' || (call.resource !== undefined && matches(x.value(), call.resource, false))) || (failClosed && call.resource === undefined);
  } else if (s.isNotResourceStatement()) {
    resourceHit = call.resource === undefined ? failClosed : !s.notResources().some((x) => x.value() === '*' || matches(x.value(), call.resource!, false));
  } else resourceHit = true;
  if (!resourceHit) return false;
  return s.conditions().length === 0 || failClosed;
}

/** Whether a managed policy allows the call: only ReadOnlyAccess is known, as IAM's Read and List actions. */
async function managedAllows(arn: string, call: Call): Promise<boolean> {
  if (arn !== READ_ONLY_ACCESS) return false;
  const details = await iamActionDetails(call.service, call.action).catch(() => undefined);
  return details?.accessLevel === 'Read' || details?.accessLevel === 'List';
}

/** The proxy's verdict on one call by one session, at `now`. */
export async function evaluate(session: Session, call: Call | undefined, now: Date): Promise<{ allowed: boolean; reason: string }> {
  if (session.revoked) return { allowed: false, reason: 'the session was revoked' };
  if (Date.parse(session.expiration) <= now.getTime()) return { allowed: false, reason: `the session expired at ${session.expiration}` };
  if (!call) return { allowed: false, reason: 'the proxy cannot name the action (fails closed)' };
  const action = `${call.service}:${call.action}`;
  const statements = session.policy ? loadPolicy(JSON.parse(session.policy)).statements() : [];
  const deny = statements.find((s) => s.isDeny() && covers(s, call, true));
  if (deny) return { allowed: false, reason: `${action} explicitly denied by the inline session policy (${deny.sid() ?? `statement ${deny.index()}`})` };
  if (!session.policy && session.policyArns.length === 0) return { allowed: true, reason: `${action}: no session policy, the role allows it` };
  for (const arn of session.policyArns) if (await managedAllows(arn, call)) return { allowed: true, reason: `${action} allowed by ${arn}` };
  if (statements.some((s) => s.isAllow() && covers(s, call, false))) return { allowed: true, reason: `${action} allowed by the inline session policy` };
  return { allowed: false, reason: `${action}: no session policy allows it (implicit deny)` };
}

/** The session an AssumeRole minted: from the request's parameters and moto's answer. */
function sessionOf(params: URLSearchParams, answer: string): Session | undefined {
  const tag = (name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(answer)?.[1];
  const accessKeyId = tag('AccessKeyId');
  const expiration = tag('Expiration');
  if (!accessKeyId || !expiration) return undefined;
  const policyArns = [...params.entries()].filter(([k]) => /^PolicyArns\.member\.\d+\.arn$/.test(k)).map(([, v]) => v);
  const policy = params.get('Policy') ?? undefined;
  return {
    accessKeyId, roleArn: params.get('RoleArn') ?? '', sessionName: params.get('RoleSessionName') ?? '',
    durationSeconds: Number(params.get('DurationSeconds') ?? 3600), policyArns, ...(policy ? { policy } : {}), expiration,
  };
}

/** A denial in the protocol the caller speaks: JSON for a JSON-protocol call, else AWS's XML. */
function denial(r: Request, message: string): { type: string; body: string } {
  if (header(r.headers, 'x-amz-target')) return { type: 'application/x-amz-json-1.1', body: JSON.stringify({ __type: 'AccessDeniedException', message }) };
  const text = message.replace(/[<>&]/g, '');
  if (signer(r)?.service === 's3') return { type: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${text}</Message></Error>` };
  return { type: 'text/xml', body: `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>${text}</Message></Error><RequestId>policy-assert</RequestId></ErrorResponse>` };
}

/**
 * The upstream's headers with one Date: moto sends two, node joins them, and the AWS SDK's clock-skew check reads the
 * joined value as an invalid date and fails the next call.
 */
const oneDate = (h: IncomingHttpHeaders): IncomingHttpHeaders => {
  const date = h.date;
  return typeof date === 'string' && date.indexOf('GMT') !== date.lastIndexOf('GMT') ? { ...h, date: date.slice(0, date.indexOf('GMT') + 3) } : h;
};

export interface PolicyAssertProxy {
  url: string;
  sessions: Map<string, Session>;
  log: Decision[];
  /** Marks a session revoked: its later calls are denied. */
  revoke(accessKeyId: string): void;
  close(): Promise<void>;
}

/**
 * Starts the proxy on loopback in front of `upstream`. `admins`: the access keys allowed every call (the seed's and the
 * minting credential's: their own identity's policy). `host`: where to listen (default 127.0.0.1).
 */
export async function startPolicyAssertProxy(o: { upstream: string; admins: string[]; host?: string; now?: () => Date }): Promise<PolicyAssertProxy> {
  const sessions = new Map<string, Session>();
  const log: Decision[] = [];
  const now = o.now ?? (() => new Date());
  const upstream = new URL(o.upstream);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const r: Request = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: raw.toString('utf8') };
      void decide(r).then((d) => {
        log.push(d);
        if (!d.allowed) {
          const deny = denial(r, `policy-assert: ${d.reason}`);
          res.writeHead(403, { 'content-type': deny.type }).end(deny.body);
          return;
        }
        const out = httpRequest({ hostname: upstream.hostname, port: upstream.port, method: r.method, path: r.url, headers: { ...req.headers, host: upstream.host } }, (up) => {
          const answer: Buffer[] = [];
          up.on('data', (c: Buffer) => answer.push(c));
          up.on('end', () => {
            const body = Buffer.concat(answer);
            if (d.action === 'sts:AssumeRole' && up.statusCode === 200) {
              const s = sessionOf(queryParams(r), body.toString('utf8'));
              if (s) sessions.set(s.accessKeyId, s);
            }
            res.writeHead(up.statusCode ?? 502, oneDate(up.headers)).end(body);
          });
        });
        out.on('error', (e) => res.writeHead(502).end(`policy-assert: upstream ${e.message}`));
        out.end(raw);
      });
    });
  });

  async function decide(r: Request): Promise<Decision> {
    const at = now();
    const base = { at: at.toISOString(), method: r.method, path: r.url.split('?')[0]! };
    const signed = signer(r);
    if (!signed) return { ...base, allowed: false, reason: 'the request is not signed' };
    const call = callOf(r);
    const named = { ...base, accessKeyId: signed.accessKeyId, ...(call ? { action: `${call.service}:${call.action}`, ...(call.resource ? { resource: call.resource } : {}) } : {}) };
    if (o.admins.includes(signed.accessKeyId)) return { ...named, allowed: true, reason: 'an admin key' };
    const session = sessions.get(signed.accessKeyId);
    if (!session) return { ...named, allowed: false, reason: 'an access key the proxy did not see minted' };
    return { ...named, ...(await evaluate(session, call, at)) };
  }

  await new Promise<void>((resolve) => server.listen(0, o.host ?? '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, sessions, log,
    revoke(accessKeyId) { const s = sessions.get(accessKeyId); if (s) s.revoked = true; },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
