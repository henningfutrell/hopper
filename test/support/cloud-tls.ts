// hopper.io over TLS for tests (issue #2039, docs/design.md "The cloud link's connection"): a self-signed certificate for
// 127.0.0.1, made by openssl for each run, and a TLS front on loopback that hands each connection to hopper.io's own port,
// as the reverse proxy in front of hopper.io does. `pin` is the pin of the certificate's public key, as the instance ships
// it; `ca` is the certificate, the root the test adds to the system's. Nothing here leaves loopback.
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { createServer, type Server } from 'node:tls';
import { pinOf } from '../../src/http/cloud-link-agent.ts';

export interface TestCertificate { cert: string; key: string; pin: string }

/** A new self-signed P-256 certificate for 127.0.0.1, valid one day. */
export function testCertificate(): TestCertificate {
  const out = execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', '-', '-out', '-',
    '-subj', '/CN=hopper.io test', '-days', '1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n/.exec(out)![0];
  const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/.exec(out)![0];
  return { cert, key, pin: pinOf(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })) };
}

/** A TLS front on a loopback port that passes each connection on to `port`: its `wss://` URL for hopper.io's link. */
export async function tlsFront(port: number, c: TestCertificate = testCertificate()): Promise<{ url: string; cert: TestCertificate; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer({ cert: c.cert, key: c.key }, (front) => {
    const back = connect(port, '127.0.0.1');
    sockets.add(front).add(back);
    front.pipe(back).pipe(front);
    const end = () => { front.destroy(); back.destroy(); sockets.delete(front); sockets.delete(back); };
    front.on('error', end).on('close', end);
    back.on('error', end).on('close', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port: front } = server.address() as { port: number };
  return {
    url: `wss://127.0.0.1:${front}/link`, cert: c,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
