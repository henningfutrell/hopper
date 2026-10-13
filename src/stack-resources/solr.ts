// The Solr meter (issue #947, design.md "Stack resources"): the search index's queries, their time, its documents and its
// index size, from Solr's own metrics API (`/solr/admin/metrics`, JSON) on the Solr of the core HOPPER_SOLR_URL names. A
// query is a request to the core's `/select`: the hopper's searches, type-ahead and counts. The counts are since the core
// was loaded; the times are Solr's own timer, which weighs the last minutes most.
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

/** The metrics API URL that reads the four metrics of the core HOPPER_SOLR_URL names. */
export function solrMetricsUrl(coreUrl: string): string {
  const { solr, core } = coreOf(coreUrl);
  const p = new URLSearchParams({ wt: 'json' });
  for (const m of METRICS) p.append('key', `solr.core.${core}:${m}`);
  return `${solr}/admin/metrics?${p}`;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function createSolrMeter(o: { url: string }): SolrMeter {
  const { core } = coreOf(o.url);
  const url = solrMetricsUrl(o.url);
  return {
    async read(): Promise<SolrReading> {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(WAIT_MS) });
      } catch (e) {
        const cause = (e as { cause?: { code?: string } }).cause;
        throw new Error(`Solr's metrics (${url}) did not answer: ${cause?.code ?? (e instanceof Error ? e.message : String(e))}`, { cause: e });
      }
      if (!res.ok) throw new Error(`Solr's metrics (${url}) answered ${res.status}`);
      const metrics = ((await res.json()) as { metrics?: Record<string, unknown> }).metrics ?? {};
      const get = (m: (typeof METRICS)[number]): unknown => metrics[`solr.core.${core}:${m}`];
      const times = get('QUERY./select.requestTimes') as { count?: unknown; mean_ms?: unknown; p95_ms?: unknown } | undefined;
      const docs = num(get('SEARCHER.searcher.numDocs'));
      const indexBytes = num(get('INDEX.sizeInBytes'));
      if (!times || docs === undefined || indexBytes === undefined) throw new Error(`Solr has no core ${core} (HOPPER_SOLR_URL), or gives none of its metrics`);
      const queries = num(times.count) ?? 0;
      const errors = num((get('QUERY./select.errors') as { count?: unknown } | undefined)?.count) ?? 0;
      const meanMs = num(times.mean_ms), p95Ms = num(times.p95_ms);
      return { queries, errors, ...(queries > 0 && meanMs !== undefined ? { meanMs } : {}), ...(queries > 0 && p95Ms !== undefined ? { p95Ms } : {}), docs, indexBytes };
    },
  };
}
