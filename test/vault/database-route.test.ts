// Issue #2231: the route to a database a bastion forwards to. It is a port on 127.0.0.1 for one read; each connection to it
// becomes one relay connection. The relay is asked once before it opens, so a bastion that does not run is said, not found
// later as a lost connection; and its end closes what is open.
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
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
