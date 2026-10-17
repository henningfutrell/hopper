// The topology sources (issue #1781, design.md "The infrastructure topology"): one row per source by its key — an AWS
// account in a region, a Kubernetes cluster —, its last good snapshot and its last read as JSON. A report of a source
// replaces its row; a failed read keeps the snapshot in it (`afterReport`), so a source out of reach loses nothing.
import type { TopologyRepository, TopologySource } from '../domain/topology.ts';
import { parse, type StoreContext } from './context.ts';

export const TOPOLOGY_TABLE = 'CREATE TABLE IF NOT EXISTS infra_topology_sources (key TEXT PRIMARY KEY, body TEXT NOT NULL)';

export function createTopologyRepository(c: StoreContext): TopologyRepository {
  return {
    get(key) {
      const r = c.db.get('SELECT body FROM infra_topology_sources WHERE key = ?', key);
      return r ? parse<TopologySource>(r.body) : undefined;
    },
    put(s) {
      c.db.run('INSERT INTO infra_topology_sources (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body', s.key, JSON.stringify(s));
    },
    list: () => c.db.all('SELECT body FROM infra_topology_sources ORDER BY key').map((r) => parse<TopologySource>(r.body)),
  };
}
