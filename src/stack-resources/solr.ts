// The Solr meter (issue #947, design.md "Stack resources"): the search index's queries, their time, its documents and its
// index size, from Solr's own metrics API (`/solr/admin/metrics`, JSON) on the Solr of the core HOPPER_SOLR_URL names. A
// query is a request to the core's `/select`: the hopper's searches, type-ahead and counts. The counts are since the core
// was loaded; the times are Solr's own timer, which weighs the last minutes most. With the search's basic auth (issue
// #2990); a managed Solr's user may not read the metrics API (Solr's `metrics-read`), and then the reading says so.
// On a SolrCloud collection (issue #2990) each replica is a core of its own, `solr.core.<collection>.<shard>.<replica>`:
// the meter reads every core of the collection on the node that answers, sums their queries, failed queries and index
// size, and counts each shard's documents once (its replica with the most). A distributed query also counts the request
// to each shard. Cores on other nodes are not read.
import type { SolrMeter, SolrReading } from '../domain/stack-resources.ts';

const WAIT_MS = 2_000;
const METRICS = ['QUERY./select.requestTimes', 'QUERY./select.errors', 'SEARCHER.searcher.numDocs', 'INDEX.sizeInBytes'] as const;

/** The core's name and its Solr: `http://solr:8983/solr/hopper` → `hopper`, `http://solr:8983/solr`. */
function coreOf(coreUrl: string): { solr: string; core: string } {
  const u = new URL(coreUrl);
  const parts = u.pathname.split('/').filter(Boolean);
  const core = parts.pop() ?? '';
  return { solr: `${u.origin}/${parts.join('/')}`.replace(/\/$/, ''), core };
}

/** The metrics API URL that reads the four metrics of every core: the core HOPPER_SOLR_URL names is picked from them. */
export function solrMetricsUrl(coreUrl: string): string {
  const { solr } = coreOf(coreUrl);
  return `${solr}/admin/metrics?${new URLSearchParams({ wt: 'json', group: 'core', prefix: METRICS.join(',') })}`;
}

/** The shard of a core's registry when it is the core, or a replica of the collection, `core` names; null: another core's. */
function shardOf(registry: string, core: string): string | null {
  const head = `solr.core.${core}`;
  if (registry === head) return '';
  if (!registry.startsWith(`${head}.`)) return null;
  const rest = registry.slice(head.length + 1).split('.');
  return rest.length === 2 && rest[1]!.startsWith('replica_') ? rest[0]! : null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function createSolrMeter(o: { url: string; authorization?: () => string | undefined }): SolrMeter {
  const { core } = coreOf(o.url);
  const url = solrMetricsUrl(o.url);
  return {
    async read(): Promise<SolrReading> {
      let res: Response;
      try {
        const authorization = o.authorization?.();
        res = await fetch(url, { signal: AbortSignal.timeout(WAIT_MS), ...(authorization ? { headers: { authorization } } : {}) });
      } catch (e) {
        const cause = (e as { cause?: { code?: string } }).cause;
        throw new Error(`Solr's metrics (${url}) did not answer: ${cause?.code ?? (e instanceof Error ? e.message : String(e))}`, { cause: e });
      }
      if (res.status === 401 || res.status === 403) throw new Error(`Solr's metrics (${url}) answered ${res.status}: the Solr user may not read the metrics API (Solr's metrics-read permission)`);
      if (!res.ok) throw new Error(`Solr's metrics (${url}) answered ${res.status}`);
      const registries = ((await res.json()) as { metrics?: Record<string, Record<string, unknown>> }).metrics ?? {};
      let queries = 0, errors = 0, indexBytes = 0, timed = 0, weighed = 0, p95Ms: number | undefined, found = false;
      const shardDocs = new Map<string, number>();
      for (const [registry, m] of Object.entries(registries)) {
        const shard = shardOf(registry, core);
        if (shard === null) continue;
        const times = m['QUERY./select.requestTimes'] as { count?: unknown; mean_ms?: unknown; p95_ms?: unknown } | undefined;
        const docs = num(m['SEARCHER.searcher.numDocs']), bytes = num(m['INDEX.sizeInBytes']);
        if (!times || docs === undefined || bytes === undefined) continue;
        found = true;
        const count = num(times.count) ?? 0, mean = num(times.mean_ms), p95 = num(times.p95_ms);
        queries += count; indexBytes += bytes;
        errors += num((m['QUERY./select.errors'] as { count?: unknown } | undefined)?.count) ?? 0;
        if (count > 0 && mean !== undefined) { timed += count; weighed += mean * count; }
        if (count > 0 && p95 !== undefined) p95Ms = Math.max(p95Ms ?? 0, p95);
        shardDocs.set(shard, Math.max(shardDocs.get(shard) ?? 0, docs));
      }
      if (!found) throw new Error(`Solr has no core ${core} (HOPPER_SOLR_URL), or gives none of its metrics`);
      const docs = [...shardDocs.values()].reduce((a, b) => a + b, 0);
      return { queries, errors, ...(timed > 0 ? { meanMs: weighed / timed } : {}), ...(p95Ms !== undefined ? { p95Ms } : {}), docs, indexBytes };
    },
  };
}
