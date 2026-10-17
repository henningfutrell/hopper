// A job's test databases in its parts list (issue #935 part, issue #975, design.md "A job's parts list" → "Test databases"):
// each container its reap removed, as the reap said it, beside job-bom.ts for its size. Pure.
import { spanText, type BomPart } from './job-bom.ts';
import type { ContainersRemoved } from './machine-shell.ts';
import type { DomainEvent } from './types.ts';

/** An image a database runs from, by any part of its name: a container of it is a test database. */
const DATABASE_IMAGE = /(^|\/)(postgres|postgis|timescaledb|mysql|mariadb|percona|mongo|redis|valkey|cockroach|clickhouse|cassandra|scylla|neo4j|couchdb|influxdb|mssql|surrealdb)[^/]*$/i;

/**
 * Its test databases (issue #975): each container a reap removed — the containers a job's tests start in its own container
 * runtime, or with its label in the machine's —, from `job.containers_removed`. A database image's is a test database,
 * any other a container. Its name, image, machine, when it started and how long it ran; it is gone, since its reap removed
 * it. A reap of a client older than this said only its id.
 */
export function testDatabases(events: readonly DomainEvent[]): BomPart[] {
  const out = new Map<string, BomPart>();
  for (const e of events) {
    if (e.type !== 'job.containers_removed') continue;
    const d = e.data as unknown as ContainersRemoved;
    const details = new Map((d.details ?? []).map((c) => [c.id, c]));
    for (const id of d.containers ?? []) {
      const c = details.get(id);
      const database = !!c && DATABASE_IMAGE.test(c.image.replace(/[:@].*$/, ''));
      const ran = !c ? undefined : !c.startedAt ? 'never started' : c.stoppedAt ? `ran ${spanText(c.startedAt, c.stoppedAt)}` : `ran ${spanText(c.startedAt, e.at)} until its reap`;
      const where = [c?.image, e.machineId ? `on ${e.machineId}` : undefined].filter(Boolean).join(' ');
      out.set(id, {
        id: `container:${id}`, group: 'machines', kind: database ? 'test_database' : 'container', label: `${database ? 'Test database' : 'Container'} ${c?.name ?? id}`,
        status: 'recorded', at: c?.startedAt ?? e.at, detail: [where, ran, 'removed by its reap'].filter(Boolean).join(', '), href: '#machines',
      });
    }
  }
  return [...out.values()];
}
