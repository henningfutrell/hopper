// Drift in the hopper's stack (issue #1077, design.md "Component watchers"): the database and the stack's health. The
// stack resources (design.md "Stack resources") against what a healthy stack is: each service of the compose stack runs
// and is not unhealthy, each part the hopper is given answers, and Postgres has room for connections and no transaction
// open too long. A sandbox box is a job's, not the stack's: not read. An item never says why a part does not answer: the
// why can name a host or a path. Pure: no I/O, no clock.
import type { Drift, DriftItem } from './drift.ts';
import { LONG_TRANSACTION_S, type StackResources } from './stack-resources.ts';

export const STACK_HEALTH = 'stack-health';

/** Postgres at this share of its connection limit is under strain. */
export const CONNECTIONS_HIGH = 0.9;

const PARTS = ['containers', 'postgres', 'openfga', 'solr'] as const;

/**
 * The drift of `r`, one per kind: `service_down` (a service of the stack does not run, or runs unhealthy),
 * `part_unreadable` (a part does not answer; a problem in `notGiven` says the hopper is not given that part, and is no
 * drift), `database_strain` (Postgres near its connection limit, or a transaction open longer than `LONG_TRANSACTION_S`).
 */
export function stackHealthDrift(r: StackResources, notGiven: ReadonlySet<string>, now: string): Drift[] {
  const byKind = new Map<string, DriftItem[]>();
  const add = (kind: string, item: DriftItem) => byKind.set(kind, [...byKind.get(kind) ?? [], item]);
  if ('containers' in r.containers) {
    for (const c of r.containers.containers.filter((x) => x.group === 'stack')) {
      if (c.state !== 'running') add('service_down', { key: c.service, says: c.state, truth: 'running' });
      else if (c.health === 'unhealthy') add('service_down', { key: c.service, says: 'running, unhealthy', truth: 'healthy', ...(c.startedAt ? { since: c.startedAt } : {}) });
    }
  }
  for (const part of PARTS) {
    const p = r[part];
    if ('problem' in p && !notGiven.has(p.problem)) add('part_unreadable', { key: part, says: 'cannot be read', truth: 'answers' });
  }
  if (!('problem' in r.postgres)) {
    const { connections: c, longTransactions, oldestTransactionS } = r.postgres;
    if (c.max > 0 && c.total >= c.max * CONNECTIONS_HIGH) add('database_strain', { key: 'postgres/connections', says: `${c.total} of ${c.max} connections`, truth: `below ${CONNECTIONS_HIGH * 100}% of the limit` });
    if (longTransactions > 0) {
      const since = oldestTransactionS === undefined ? {} : { since: new Date(Date.parse(now) - oldestTransactionS * 1000).toISOString() };
      add('database_strain', { key: 'postgres/long-transactions', says: `${longTransactions} transaction(s) open over ${LONG_TRANSACTION_S / 60} minutes`, truth: 'none', ...since });
    }
  }
  return [...byKind].map(([kind, items]) => ({ watcher: STACK_HEALTH, kind, items }));
}
