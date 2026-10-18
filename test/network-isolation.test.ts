// No request leaves this machine in a test, from any client (issue #1955): the socket guard
// (test/support/network-guard.ts) refuses every connection and DNS lookup off loopback, not only fetch. A missing fake
// then fails with a test isolation error, never by a real endpoint's answer (issue #1766: an AWS SDK call reached real AWS).
import { execFile } from 'node:child_process';
import dns from 'node:dns';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, createConnection, type AddressInfo } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { request as octokitRequest } from '@octokit/request';
import { describe, expect, it } from 'vitest';
import { allowedHost, ISOLATION_CODE } from './support/network-guard.ts';

const ISOLATION = /test isolation: refused/;
const FAR = 'far.example.com';

/** The error a socket fails with, or undefined when it connected. */
const socketError = (socket: { once: (e: string, f: (x?: unknown) => void) => unknown; destroy: () => void }): Promise<unknown> =>
  new Promise((done) => {
    socket.once('error', done);
    socket.once('connect', () => { socket.destroy(); done(undefined); });
    socket.once('secureConnect', () => { socket.destroy(); done(undefined); });
  });

const requestError = (req: ReturnType<typeof httpRequest>): Promise<Error> =>
  new Promise((done, fail) => { req.once('error', done); req.once('response', () => fail(new Error('answered'))); req.end(); });

describe('socket-level test isolation', () => {
  it('a raw net.connect off loopback fails with the isolation error, by name or by address', async () => {
    const byName = await socketError(connect(443, FAR));
    expect(byName).toMatchObject({ code: ISOLATION_CODE, message: expect.stringMatching(ISOLATION) });
    expect(String((byName as Error).message)).toContain(`${FAR}:443`);
    expect(await socketError(createConnection({ host: '192.0.2.1', port: 80 }))).toMatchObject({ code: ISOLATION_CODE });
  });

  it('a raw tls.connect off loopback fails with the isolation error', async () => {
    expect(await socketError(tlsConnect({ host: FAR, port: 443, servername: FAR }))).toMatchObject({ code: ISOLATION_CODE });
  });

  it('a raw https.request and http.request off loopback fail with the isolation error', async () => {
    expect(await requestError(httpsRequest(`https://${FAR}/x`))).toMatchObject({ message: expect.stringMatching(ISOLATION) });
    expect(await requestError(httpRequest({ host: '192.0.2.1', port: 80, path: '/' }))).toMatchObject({ code: ISOLATION_CODE });
  });

  it('an AWS SDK call fails with the isolation error, never by a real AWS answer', async () => {
    const sts = new STSClient({ region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test' } });
    await expect(sts.send(new GetCallerIdentityCommand({}))).rejects.toThrow(ISOLATION);
  });

  it('an Octokit request fails with the isolation error', async () => {
    await expect(octokitRequest('GET /zen', { request: { retries: 0 } })).rejects.toThrow(ISOLATION);
  });

  it('a Kubernetes client call fails with the isolation error', async () => {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 'c', server: `https://${FAR}:6443`, skipTLSVerify: true }],
      users: [{ name: 'u', token: 'test' }],
      contexts: [{ name: 'x', cluster: 'c', user: 'u' }],
      currentContext: 'x',
    });
    // Its own undici fetch says "fetch failed"; the cause is the guard's.
    const err = await kc.makeApiClient(CoreV1Api).listNamespace().then(() => undefined, (e: unknown) => e);
    expect(err).toMatchObject({ cause: { code: ISOLATION_CODE, message: expect.stringMatching(ISOLATION) } });
  });

  it('a DNS lookup or query of a name off this machine fails, as an unknown name does', async () => {
    await expect(lookup(FAR)).rejects.toMatchObject({ code: 'ENOTFOUND', message: expect.stringMatching(ISOLATION) });
    await expect(dns.promises.resolve4(FAR)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(new dns.promises.Resolver().resolveTxt(FAR)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(promisify(dns.lookup)(FAR)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await expect(promisify(dns.resolve6)(FAR)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    expect((await lookup('localhost')).address).toMatch(/^(127\.|::1$)/);
  });

  it('loopback, unix sockets and the test services stay reachable', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await socketError(connect(port, '127.0.0.1'))).toBeUndefined();
      expect(await socketError(connect({ port, host: 'localhost' }))).toBeUndefined();
    } finally { server.close(); }
    for (const host of ['localhost', 'a.localhost', '127.0.0.9', '::1', '[::1]', '::ffff:127.0.0.1']) expect(allowedHost(host)).toBe(true);
    expect(allowedHost('svc.example.net', { HOPPER_TEST_SOLR_URL: 'http://svc.example.net:8983/solr/hopper' })).toBe(true);
    expect(allowedHost('svc.example.net', { OTHER_URL: 'http://svc.example.net/' })).toBe(false);
    expect(allowedHost('172.17.0.1', { TESTCONTAINERS_HOST_OVERRIDE: '172.17.0.1' })).toBe(true);
    expect(allowedHost('192.0.2.1')).toBe(false);
  });

  it('a node process a test starts is guarded too', async () => {
    const script = `require('node:net').connect(443, '${FAR}').on('error', (e) => { console.log(e.code); process.exit(0); }).on('connect', () => process.exit(1));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], { env: process.env });
    expect(stdout.trim()).toBe(ISOLATION_CODE);
  });
});
