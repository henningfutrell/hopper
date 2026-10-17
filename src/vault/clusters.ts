// The user's cluster overrides (issue #1766): the config record `clusters`, read and replaced whole against its version,
// from the UI (POST /ui/api/clusters) or with `hopper config set`. Read at each mint, so an edit reaches the next mint
// without a restart. A config record, not a vault secret: a cluster holds no secret.
import type { ConfigRecords } from '../domain/ports.ts';
import { CLUSTERS, clustersOf, clustersProblem, type ClusterOverride, type ClustersView } from '../domain/clusters.ts';

/** The overrides now; none while the record is missing. */
export const readClusters = (config: Pick<ConfigRecords, 'read'>): ClusterOverride[] => clustersOf(config.read(CLUSTERS));

export function clustersView(config: ConfigRecords): ClustersView {
  return { clusters: readClusters(config), version: config.version(CLUSTERS) };
}

export type ClustersWrite = { ok: true; view: ClustersView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the overrides with `clusters` if the record is still at `version`. A field left empty is dropped. */
export function writeClusters(config: ConfigRecords, clusters: ClusterOverride[], version: string): ClustersWrite {
  const value = { clusters: clusters.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]).filter(([, v]) => v !== '' && v !== undefined)) as unknown as ClusterOverride) };
  const problem = clustersProblem(value);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!config.write(CLUSTERS, value, version)) return { ok: false, code: 'conflict', error: 'the cluster overrides changed since they were read; reload and edit again' };
  return { ok: true, view: clustersView(config) };
}
