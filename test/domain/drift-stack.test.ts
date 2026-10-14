// Drift in the hopper's stack (issue #1077, the last part): the database and the stack's health. The stack resources —
// each container of the hopper's compose stack, Postgres, OpenFGA and Solr — against what a healthy stack is.
//
// Feature: the stack-health comparison
//   Scenario: a service of the stack is down or unhealthy
//   Scenario: a part the hopper is given does not answer
//   Scenario: Postgres is near its connection limit, or holds a long transaction
//   Scenario: a healthy stack, a sandbox box, or a part the hopper is not given is no drift
import { describe, expect, it } from 'vitest';
import { STACK_HEALTH, stackHealthDrift } from '../../src/domain/drift-stack.ts';
import type { ContainerReading, PostgresReading, StackResources } from '../../src/domain/stack-resources.ts';

const NOW = '2026-10-13T12:00:00.000Z';
const container = (service: string, state: string, extra: Partial<ContainerReading> = {}): ContainerReading => ({ service, group: 'stack', name: `hopper-${service}-1`, image: 'img', state, ...extra });
const postgres = (extra: Partial<PostgresReading> = {}): PostgresReading => ({
  connections: { active: 1, total: 10, max: 100 }, databaseBytes: 1, locksWaiting: 0, longTransactions: 0, statements: { calls: 0, meanMs: 0 }, ...extra,
});
const healthy = (extra: Partial<StackResources> = {}): StackResources => ({
  at: NOW, containers: { containers: [container('hopper', 'running'), container('postgres', 'running', { health: 'healthy' })] }, remoteBoxes: [],
  postgres: postgres(), openfga: { checks: 1, errors: 0 }, solr: { queries: 0, errors: 0, docs: 0, indexBytes: 0, pending: 0 }, ...extra,
});
const NOT_GIVEN = new Set(['no openfga given']);

describe('stack-health drift', () => {
  it('gives no drift for a healthy stack, a sandbox box that stopped, or a part the hopper is not given', () => {
    const box = container('box-1', 'exited', { group: 'sandbox' });
    expect(stackHealthDrift(healthy({ containers: { containers: [container('hopper', 'running'), box] }, openfga: { problem: 'no openfga given' } }), NOT_GIVEN, NOW)).toEqual([]);
  });

  it('finds a service of the stack that does not run, or runs unhealthy', () => {
    const r = healthy({ containers: { containers: [container('hopper', 'running'), container('openfga', 'exited'), container('postgres', 'running', { health: 'unhealthy', startedAt: '2026-10-13T11:00:00.000Z' })] } });
    expect(stackHealthDrift(r, NOT_GIVEN, NOW)).toEqual([
      {
        watcher: STACK_HEALTH, kind: 'service_down', items: [
          { key: 'openfga', says: 'exited', truth: 'running' },
          { key: 'postgres', says: 'running, unhealthy', truth: 'healthy', since: '2026-10-13T11:00:00.000Z' },
        ],
      },
    ]);
  });

  it('finds a part the hopper is given that does not answer, and never says why in the item', () => {
    const r = healthy({ containers: { problem: 'connect ENOENT /run/podman.sock' }, openfga: { problem: 'fetch failed: http://openfga:2112' }, solr: { problem: 'down', pending: 3 } });
    expect(stackHealthDrift(r, NOT_GIVEN, NOW)).toEqual([
      {
        watcher: STACK_HEALTH, kind: 'part_unreadable', items: [
          { key: 'containers', says: 'cannot be read', truth: 'answers' },
          { key: 'openfga', says: 'cannot be read', truth: 'answers' },
          { key: 'solr', says: 'cannot be read', truth: 'answers' },
        ],
      },
    ]);
    expect(stackHealthDrift(healthy({ postgres: { problem: 'x' } }), NOT_GIVEN, NOW)[0]?.items).toEqual([{ key: 'postgres', says: 'cannot be read', truth: 'answers' }]);
  });

  it('finds Postgres near its connection limit, and a transaction open too long', () => {
    const r = healthy({ postgres: postgres({ connections: { active: 5, total: 92, max: 100 }, longTransactions: 2, oldestTransactionS: 600 }) });
    expect(stackHealthDrift(r, NOT_GIVEN, NOW)).toEqual([
      {
        watcher: STACK_HEALTH, kind: 'database_strain', items: [
          { key: 'postgres/connections', says: '92 of 100 connections', truth: 'below 90% of the limit' },
          { key: 'postgres/long-transactions', says: '2 transaction(s) open over 5 minutes', truth: 'none', since: '2026-10-13T11:50:00.000Z' },
        ],
      },
    ]);
  });
});
