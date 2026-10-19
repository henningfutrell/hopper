// Issue #1956: the policy-assert proxy the cloud acceptance tests put in front of moto. Here in front of a loopback
// upstream that answers AssumeRole as STS does and anything else with 200, with requests signed by the AWS SDK's own
// SigV4 signer, so what the proxy reads is what an SDK or the aws CLI sends.
//
// Feature: the policy-assert proxy re-checks every SigV4 request against its session policy
//   Scenario: it learns a session from the AssumeRole that minted it: role, name, duration, policies, expiry
//   Scenario: a read session's reads pass; its writes are denied by the deny policy or by ReadOnlyAccess
//   Scenario: an unsigned call, an unknown key, an expired or revoked session, and a call it cannot name are denied
//   Scenario: a session with no session policy gets what the role allows
//   Scenario: it names the IAM action of the query, JSON, S3 REST and EKS REST protocols
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpRequest } from '@smithy/core/protocols';
import { Hash } from '@smithy/core/serde';
import { SignatureV4 } from '@smithy/signature-v4';
import { awsReadSession } from '../../src/domain/minting.ts';
import { callOf, evaluate, READ_ONLY_ACCESS, startPolicyAssertProxy, type PolicyAssertProxy, type Session } from './policy-assert-proxy.ts';

const ROLE = 'arn:aws:iam::123456789012:role/read';
const NOW = new Date('2030-01-01T00:00:00Z');
const read: Session = { accessKeyId: 'ASIAREAD', roleArn: ROLE, sessionName: 's', durationSeconds: 900, ...awsReadSession(ROLE), expiration: '2030-01-01T00:15:00Z' };

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

async function upstream(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      if (body.includes('Action=AssumeRole')) {
        res.writeHead(200, { 'content-type': 'text/xml' }).end('<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAMINTED</AccessKeyId><SecretAccessKey>x</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2030-01-01T00:15:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>');
      } else res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** Sends a request signed with SigV4 for `service` by `key` through the proxy; its status and body. */
async function signed(p: PolicyAssertProxy, key: string, service: string, r: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }) {
  const url = new URL(p.url);
  const sig = new SignatureV4({ service, region: 'us-east-1', sha256: Hash.bind(null, 'sha256'), credentials: { accessKeyId: key, secretAccessKey: 'secret' } });
  const req = await sig.sign(new HttpRequest({ method: r.method, protocol: 'http:', hostname: url.hostname, port: Number(url.port), path: r.path, query: r.query ?? {}, headers: { host: url.host, ...r.headers }, body: r.body }));
  const qs = new URLSearchParams(r.query ?? {}).toString();
  const res = await fetch(`${p.url}${r.path}${qs ? `?${qs}` : ''}`, { method: r.method, headers: req.headers, ...(r.body !== undefined ? { body: r.body } : {}) });
  return { status: res.status, body: await res.text() };
}

const form = { 'content-type': 'application/x-www-form-urlencoded' };

describe('the policy-assert proxy (issue #1956)', () => {
  it('learns a session from the AssumeRole that minted it, then allows its reads and denies its writes', async () => {
    const up = await upstream();
    const p = await startPolicyAssertProxy({ upstream: up.url, admins: ['AKIAMINTING'], now: () => NOW });
    closers.push(() => p.close());
    const { policyArns, policy } = awsReadSession(ROLE);
    const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: ROLE, RoleSessionName: 'hopper-j1', DurationSeconds: '900', 'PolicyArns.member.1.arn': policyArns[0]!, Policy: policy }).toString();
    expect((await signed(p, 'AKIAMINTING', 'sts', { method: 'POST', path: '/', headers: form, body })).status).toBe(200);
    expect(p.sessions.get('ASIAMINTED')).toEqual({ accessKeyId: 'ASIAMINTED', roleArn: ROLE, sessionName: 'hopper-j1', durationSeconds: 900, policyArns: [READ_ONLY_ACCESS], policy, expiration: '2030-01-01T00:15:00Z' });

    expect((await signed(p, 'ASIAMINTED', 'ec2', { method: 'POST', path: '/', headers: form, body: 'Action=DescribeInstances&Version=2016-11-15' })).status).toBe(200);
    expect((await signed(p, 'ASIAMINTED', 's3', { method: 'GET', path: '/bucket', query: { 'list-type': '2' } })).status).toBe(200);
    const terminate = await signed(p, 'ASIAMINTED', 'ec2', { method: 'POST', path: '/', headers: form, body: 'Action=TerminateInstances&Version=2016-11-15&InstanceId.1=i-1' });
    expect(terminate.status).toBe(403);
    expect(terminate.body).toContain('<Code>AccessDenied</Code>');
    const put = await signed(p, 'ASIAMINTED', 's3', { method: 'PUT', path: '/bucket/key', body: 'x' });
    expect(put.status).toBe(403);
    const kms = await signed(p, 'ASIAMINTED', 'kms', { method: 'POST', path: '/', headers: { 'x-amz-target': 'TrentService.ScheduleKeyDeletion', 'content-type': 'application/x-amz-json-1.1' }, body: '{}' });
    expect(kms.status).toBe(403);
    expect(JSON.parse(kms.body)).toMatchObject({ __type: 'AccessDeniedException' });
    // Nothing denied reached the upstream.
    expect(up.seen).toEqual(['POST /', 'POST /', 'GET /bucket?list-type=2']);
    expect(p.log.map((d) => [d.action, d.allowed])).toEqual([
      ['sts:AssumeRole', true], ['ec2:DescribeInstances', true], ['s3:ListBucket', true],
      ['ec2:TerminateInstances', false], ['s3:PutObject', false], ['kms:ScheduleKeyDeletion', false],
    ]);
  });

  it('denies an unsigned call, an unknown key, and every call of a revoked session', async () => {
    const up = await upstream();
    const p = await startPolicyAssertProxy({ upstream: up.url, admins: [] });
    closers.push(() => p.close());
    expect((await fetch(`${p.url}/bucket`)).status).toBe(403);
    expect((await signed(p, 'ASIAUNKNOWN', 's3', { method: 'GET', path: '/bucket' })).status).toBe(403);
    p.sessions.set('ASIAREAD', { ...read, expiration: '2999-01-01T00:00:00Z' });
    expect((await signed(p, 'ASIAREAD', 's3', { method: 'GET', path: '/bucket' })).status).toBe(200);
    p.revoke('ASIAREAD');
    expect((await signed(p, 'ASIAREAD', 's3', { method: 'GET', path: '/bucket' })).status).toBe(403);
    expect(p.log.map((d) => d.reason)).toEqual(['the request is not signed', 'an access key the proxy did not see minted', 's3:ListBucket allowed by arn:aws:iam::aws:policy/ReadOnlyAccess', 'the session was revoked']);
    expect(up.seen).toHaveLength(1);
  });

  it('judges a read session as AWS would: deny policy first, then ReadOnlyAccess; an expired session and an unnamed call are denied', async () => {
    const at = async (action: string, resource?: string) => (await evaluate(read, { service: action.split(':')[0]!, action: action.split(':')[1]!, ...(resource ? { resource } : {}) }, NOW)).allowed;
    for (const allowed of ['sts:GetCallerIdentity', 'ec2:DescribeInstances', 's3:GetObject', 'sqs:ListQueues', 'kms:DescribeKey']) expect(await at(allowed), allowed).toBe(true);
    // Denied by the deny policy (named verbs), or by ReadOnlyAccess alone (no read level): terminate, send, schedule.
    for (const denied of ['s3:PutObject', 's3:DeleteObject', 'ec2:CreateTags', 'iam:AttachRolePolicy', 'ec2:TerminateInstances', 'sqs:SendMessage', 'sqs:DeleteQueue', 'kms:ScheduleKeyDeletion']) expect(await at(denied), denied).toBe(false);
    expect(await at('sts:AssumeRole', 'arn:aws:iam::123456789012:role/write')).toBe(false);
    expect((await evaluate(read, { service: 'sts', action: 'AssumeRole', resource: 'arn:aws:iam::123456789012:role/write' }, NOW)).reason).toMatch(/HopperReadNoOtherRole/);
    expect(await evaluate(read, { service: 's3', action: 'GetObject' }, new Date('2030-01-01T00:15:00Z'))).toEqual({ allowed: false, reason: 'the session expired at 2030-01-01T00:15:00Z' });
    expect((await evaluate(read, undefined, NOW)).allowed).toBe(false);
    // A write session (no session policy) is what the role allows.
    expect((await evaluate({ ...read, policyArns: [], policy: undefined }, { service: 'ec2', action: 'TerminateInstances' }, NOW)).allowed).toBe(true);
  });

  it('names the action of the query, JSON, S3 REST and EKS REST protocols', () => {
    const auth = (service: string) => ({ authorization: `AWS4-HMAC-SHA256 Credential=ASIAX/20300101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=0` });
    const s3 = (method: string, url: string, headers: Record<string, string> = {}) => callOf({ method, url, headers: { ...auth('s3'), ...headers }, body: '' });
    expect(s3('GET', '/')).toEqual({ service: 's3', action: 'ListAllMyBuckets', resource: '*' });
    expect(s3('GET', '/b?location')).toMatchObject({ action: 'GetBucketLocation' });
    expect(s3('HEAD', '/b/k%20x')).toEqual({ service: 's3', action: 'GetObject', resource: 'arn:aws:s3:::b/k x' });
    expect(s3('DELETE', '/b/k')).toMatchObject({ action: 'DeleteObject' });
    expect(s3('POST', '/b?delete')).toMatchObject({ action: 'DeleteObject' });
    expect(s3('PUT', '/b')).toMatchObject({ action: 'CreateBucket' });
    expect(s3('PATCH', '/b/k')).toBeUndefined();
    expect(callOf({ method: 'POST', url: '/', headers: { ...auth('sqs'), 'x-amz-target': 'AmazonSQS.DeleteQueue' }, body: '{}' })).toEqual({ service: 'sqs', action: 'DeleteQueue' });
    expect(callOf({ method: 'POST', url: '/', headers: { ...auth('sts'), ...form }, body: 'Action=AssumeRole&RoleArn=arn%3Aaws%3Aiam%3A%3A1%3Arole%2Fr' })).toEqual({ service: 'sts', action: 'AssumeRole', resource: 'arn:aws:iam::1:role/r' });
    expect(callOf({ method: 'GET', url: '/?X-Amz-Credential=ASIAX%2F20300101%2Fus-east-1%2Fsts%2Faws4_request&Action=GetCallerIdentity', headers: {}, body: '' })).toEqual({ service: 'sts', action: 'GetCallerIdentity' });
    expect(callOf({ method: 'GET', url: '/', headers: {}, body: '' })).toBeUndefined();
    // EKS speaks REST: topology discovery lists and describes its clusters.
    const eks = (method: string, url: string) => callOf({ method, url, headers: auth('eks'), body: '' });
    expect(eks('GET', '/clusters?maxResults=100')).toEqual({ service: 'eks', action: 'ListClusters' });
    expect(eks('GET', '/clusters/prod')).toEqual({ service: 'eks', action: 'DescribeCluster' });
    expect(eks('DELETE', '/clusters/prod')).toEqual({ service: 'eks', action: 'DeleteCluster' });
    expect(eks('POST', '/clusters')).toEqual({ service: 'eks', action: 'CreateCluster' });
    expect(eks('GET', '/clusters/prod/node-groups')).toBeUndefined();
  });
});
