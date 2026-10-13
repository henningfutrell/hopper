// Stack resources (issue #947) through the real daemon, store and HTTP server: GET /api/resources answers every container
// of the stack and each sandbox box as the container meter reads them, and the hopper's Postgres as Postgres itself says.
// The container meter is the seam (its adapter: test/adapters/container-meter.test.ts); Postgres is the real one.
//
// Feature: one read of what every part of the stack uses
//   Scenario: the containers as the meter reads them, and Postgres's connections, size, cache, locks and transactions
//   Scenario: with no runtime socket, the containers say why, and Postgres is still read
//   Scenario: statement latency says why there is none when pg_stat_statements is not installed
//   Scenario: OpenFGA's checks as its meter reads them; with no OpenFGA, or a meter that fails, it says why
//   Scenario: the sandbox boxes on each client target as their meter reads them; none with no box there
import { afterEach, describe, expect, it } from 'vitest';
import type { ContainerMeter, ContainerReading, OpenFgaMeter, PostgresReading, RemoteBoxMeter, StackResources } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const POSTGRES: ContainerReading = {
  service: 'postgres', group: 'stack', name: 'hopper-postgres-1', image: 'postgres:17-alpine', state: 'running', health: 'healthy',
  startedAt: '2026-10-12T09:00:00.000Z', restarts: 1, cpuCores: 0.25, memUsedBytes: 300 * 1024 ** 2, netRxBytes: 10, netTxBytes: 20,
};

async function boot(meter?: ContainerMeter, openFgaMeter?: OpenFgaMeter, remoteBoxMeter?: RemoteBoxMeter): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, seams: { ...(meter ? { containerMeter: meter } : {}), ...(openFgaMeter ? { openFgaMeter } : {}), ...(remoteBoxMeter ? { remoteBoxMeter } : {}) } });
  apps.push(a);
  return a;
}

const isReading = (p: StackResources['postgres']): p is PostgresReading => !('problem' in p);

describe('stack resources', () => {
  it('answers the containers as the meter reads them, and the hopper\'s Postgres', async () => {
    const a = await boot({ read: async () => ({ containers: [POSTGRES] }) });
    const r = await a.api<StackResources>('GET', '/api/resources');
    expect(r.status).toBe(200);
    expect(r.body.containers).toEqual({ containers: [POSTGRES] });
    // No sandbox record names a client target: no machine is read.
    expect(r.body.remoteBoxes).toEqual([]);
    expect(Date.parse(r.body.at)).not.toBeNaN();
    const pg = r.body.postgres;
    if (!isReading(pg)) throw new Error(pg.problem);
    expect(pg.connections.total).toBeGreaterThanOrEqual(1);
    expect(pg.connections.active).toBeGreaterThanOrEqual(1);
    expect(pg.connections.active).toBeLessThanOrEqual(pg.connections.total);
    expect(pg.connections.max).toBeGreaterThanOrEqual(pg.connections.total);
    expect(pg.databaseBytes).toBeGreaterThan(0);
    expect(pg.locksWaiting).toBeGreaterThanOrEqual(0);
    expect(pg.longTransactions).toBeGreaterThanOrEqual(0);
    expect(pg.cacheHitFrac).toBeGreaterThan(0);
    expect(pg.cacheHitFrac).toBeLessThanOrEqual(1);
  });

  it('with no runtime socket, the containers say why, and Postgres is still read', async () => {
    const a = await boot();
    const r = await a.api<StackResources>('GET', '/api/resources');
    expect(r.status).toBe(200);
    expect(r.body.containers).toEqual({ problem: expect.stringContaining('HOPPER_PODMAN_SOCKET') });
    expect(isReading(r.body.postgres)).toBe(true);
  });

  it('a meter that throws is a problem of the containers, not a failed read', async () => {
    const a = await boot({ read: async () => { throw new Error('socket hung up'); } });
    const r = await a.api<StackResources>('GET', '/api/resources');
    expect(r.status).toBe(200);
    expect(r.body.containers).toEqual({ problem: 'socket hung up' });
  });

  it('statement latency says why there is none when pg_stat_statements is not installed', async () => {
    const a = await boot();
    const pg = (await a.api<StackResources>('GET', '/api/resources')).body.postgres;
    if (!isReading(pg)) throw new Error(pg.problem);
    // The test database has no pg_stat_statements; compose.yaml loads it (test/scripts/compose.test.ts).
    expect(pg.statements).toEqual({ problem: expect.stringContaining('pg_stat_statements') });
  });

  it('answers OpenFGA\'s checks as its meter reads them', async () => {
    const a = await boot(undefined, { read: async () => ({ checks: 100, errors: 3, meanMs: 1 }) });
    const r = await a.api<StackResources>('GET', '/api/resources');
    expect(r.body.openfga).toEqual({ checks: 100, errors: 3, meanMs: 1 });
  });

  it('with no OpenFGA, or a meter that fails, OpenFGA says why and the rest is still read', async () => {
    const none = await boot();
    const r = await none.api<StackResources>('GET', '/api/resources');
    expect(r.body.openfga).toEqual({ problem: expect.stringContaining('HOPPER_OPENFGA_URL') });
    expect(isReading(r.body.postgres)).toBe(true);
    const failing = await boot(undefined, { read: async () => { throw new Error('OpenFGA\'s metrics answered 503'); } });
    expect((await failing.api<StackResources>('GET', '/api/resources')).body.openfga).toEqual({ problem: 'OpenFGA\'s metrics answered 503' });
  });

  it('answers the sandbox boxes on each client target as their meter reads them', async () => {
    const box: ContainerReading = { service: 'laptop/hopper-sandbox-kube', group: 'sandbox', machine: 'laptop', name: 'hopper-sandbox-kube', image: 'box:1', state: 'running', cpuCores: 0.5, cores: 4 };
    const remote = [{ machine: 'gone', problem: 'no client target gone' }, { machine: 'laptop', containers: [box] }];
    const a = await boot({ read: async () => ({ containers: [POSTGRES] }) }, undefined, { read: async () => remote });
    const r = await a.api<StackResources>('GET', '/api/resources');
    expect(r.status).toBe(200);
    expect(r.body.remoteBoxes).toEqual(remote);
    expect(r.body.containers).toEqual({ containers: [POSTGRES] });
  });
});
