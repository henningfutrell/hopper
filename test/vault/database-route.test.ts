// Issue #2231: the route to a database a bastion forwards to. It is a port on 127.0.0.1 for one read; each connection to it
// becomes one relay connection. The relay is asked once before it opens, so a bastion that does not run is said, not found
// later as a lost connection; and its end closes what is open.
import { execFileSync } from 'node:child_process';
import { connect, createServer, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
import type { DatabaseMintingCredential } from '../../src/domain/database-read.ts';
import { createPostgresReader } from '../../src/vault/postgres-reads.ts';
import { openDatabaseRoute } from '../../src/vault/database-route.ts';

const TARGET = 'lab/apps/svc/db:5432';

/** Connects, writes `x`, and answers what comes back first, or `closed`. */
const exchange = (port: number): Promise<string> => new Promise((done) => {
  const s = connect(port, '127.0.0.1', () => { s.write('x'); });
  s.once('data', (d) => { s.destroy(); done(d.toString()); }).once('close', () => done('closed')).once('error', () => done('closed'));
});
const echo = (): PassThrough => new PassThrough();

describe('a route to a database through a bastion (issue #2231)', () => {
  it('answers the relay\'s no and opens nothing when the relay refuses at once', async () => {
    expect(await openDatabaseRoute(TARGET, async () => ({ status: 404, no: 'no bastion' }))).toEqual({ status: 404, no: 'no bastion' });
  });

  it('joins each connection to a relay connection of its own, the first to the one asked at the start', async () => {
    const asked: string[] = [];
    const route = await openDatabaseRoute(TARGET, async (t) => { asked.push(t); return echo(); });
    if ('no' in route) throw new Error(route.no);
    expect(asked).toEqual([TARGET]);
    expect(await exchange(route.port)).toBe('x');
    expect(asked).toHaveLength(1);
    expect(await exchange(route.port)).toBe('x');
    expect(asked).toHaveLength(2);
    route.close();
  });

  it('keeps what the relay refused later, and closes that connection', async () => {
    let n = 0;
    const route = await openDatabaseRoute(TARGET, async () => (n++ === 0 ? echo() : { status: 403, no: 'Access denies the relay' }));
    if ('no' in route) throw new Error(route.no);
    expect(route.problem()).toBeUndefined();
    await exchange(route.port);
    expect(await exchange(route.port)).toBe('closed');
    expect(route.problem()).toBe('Access denies the relay');
    route.close();
  });

  it('at its close ends every pipe, the one no connection took, and takes no more connections', async () => {
    const pipes: PassThrough[] = [];
    const route = await openDatabaseRoute(TARGET, async () => { const p = echo(); pipes.push(p); return p; });
    if ('no' in route) throw new Error(route.no);
    route.close();
    expect(pipes.every((p) => p.destroyed)).toBe(true);
    expect(await exchange(route.port)).toBe('closed');
  });

  it('a pipe that ends closes its connection', async () => {
    const pipes: PassThrough[] = [];
    const route = await openDatabaseRoute(TARGET, async () => { const p = echo(); pipes.push(p); return p; });
    if ('no' in route) throw new Error(route.no);
    const closed = new Promise<void>((done) => { const s = connect(route.port, '127.0.0.1'); s.on('error', () => {}).once('close', () => done()); s.once('connect', () => { setTimeout(() => pipes[0]!.destroy(), 10); }); });
    await closed;
    route.close();
  });
});

describe('TLS through the route (issue #2231)', () => {
  /** A Postgres as far as TLS: answers the SSL request, then takes TLS with a certificate for `orders-db.apps.svc`; says whether a handshake passed. */
  async function tlsDatabase(cert: string, key: string): Promise<{ port: number; handshakes: () => number; close(): void }> {
    let handshakes = 0;
    const server = createServer((plain) => {
      plain.on('error', () => {});
      plain.once('data', () => {
        plain.write('S', () => {
          const t = new TLSSocket(plain, { isServer: true, cert, key });
          t.on('error', () => {}).once('secure', () => { handshakes++; });
          t.once('data', () => t.destroy());
        });
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { port: (server.address() as AddressInfo).port, handshakes: () => handshakes, close: () => { server.close(); } };
  }
  const NAME = 'orders-db.apps.svc';
  const certificate = (): { cert: string; key: string } => {
    const out = execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', '-', '-out', '-', '-subj', `/CN=${NAME}`, '-days', '1', '-addext', `subjectAltName=DNS:${NAME}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { key: /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n/.exec(out)![0], cert: /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/.exec(out)![0] };
  };

  it('checks the certificate against the credential\'s host, not the route\'s end', async () => {
    const { cert, key } = certificate();
    const db = await tlsDatabase(cert, key);
    const route = await openDatabaseRoute(TARGET, async () => connect(db.port, '127.0.0.1'));
    if ('no' in route) throw new Error(route.no);
    const c: DatabaseMintingCredential = { engine: 'postgres', host: '127.0.0.1', port: route.port, database: 'd', user: 'u', password: 'p', sslmode: 'verify-full', ca: cert, schemas: ['app'], tables: [] };
    const mint = createPostgresReader().mint;
    const r = { role: 'hopper_read_x', password: 'pw', validUntil: new Date(Date.now() + 60_000) };
    await expect(mint(c, r)).rejects.toThrow(/IP: 127\.0\.0\.1 is not in the cert's list/);
    expect(db.handshakes()).toBe(0);
    await expect(mint({ ...c, tlsName: NAME }, r)).rejects.toThrow(/Connection terminated/);
    expect(db.handshakes()).toBe(1);
    await expect(mint({ ...c, tlsName: 'other.apps.svc' }, r)).rejects.toThrow(/does not match certificate's altnames/);
    route.close();
    db.close();
  }, 30_000);
});
