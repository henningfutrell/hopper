// Issue #947: the Solr meter. Against a real Solr (test/support/solr.ts), one core as compose.yaml makes it: its queries,
// their time, its documents and its index size, from Solr's own metrics API. Against a double of that API: the exact
// numbers (its text is what Solr 9.11 answers, taken from a live server), a core Solr does not hold, an error, no answer.
//
// Feature: the hopper reads Solr's query latency and index size from Solr's own metrics
//   Scenario: a real Solr: after documents are written and searched, the meter reads the queries, their time, the documents and the index size
//   Scenario: the queries, failed queries, mean and 95th percentile time, documents and index size are read from the metrics API
//   Scenario: before any query, there is no query time
//   Scenario: the metrics URL is the Solr of the core HOPPER_SOLR_URL names
//   Scenario: a core Solr does not hold, an error status, or no answer is a failed read
//   Scenario: a SolrCloud collection (issue #2990): its replicas' cores, summed; each shard's documents once
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSolrIndex } from '../../src/search/solr.ts';
import { createSolrMeter, solrMetricsUrl } from '../../src/stack-resources/solr.ts';
import { startTestSolr, type TestSolr } from '../support/solr.ts';
import { waitFor } from '../support/wait.ts';

let server: Server | undefined;
afterEach(async () => { await new Promise((r) => server ? server.close(r) : r(undefined)); server = undefined; });

/** A double of Solr's metrics API; answers `body` at /solr/admin/metrics. The core's URL it serves. */
async function serve(status: number, body: unknown): Promise<string> {
  server = createServer((req, res) => {
    const ok = req.url?.startsWith('/solr/admin/metrics?') === true;
    res.writeHead(ok ? status : 404, { 'content-type': 'application/json' });
    res.end(ok ? JSON.stringify(body) : '{}');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/solr/hopper`;
}

const timer = (count: number, mean: number, p95: number) => ({
  count, meanRate: 0.07, '1minRate': 0.33, '5minRate': 0.53, '15minRate': 0.57,
  min_ms: 1.41, max_ms: 8.06, mean_ms: mean, median_ms: 4.1, stddev_ms: 2.73, p75_ms: 8.06, p95_ms: p95, p99_ms: 8.06, p999_ms: 8.06,
});
/** The metrics API's answer to `group=core&prefix=…`: each core's registry and its metrics, as Solr 9.11 gives it. */
const metrics = (cores: Record<string, Record<string, unknown>>) => ({ responseHeader: { status: 0, QTime: 0 }, metrics: cores });
const core = (requests: ReturnType<typeof timer>, errors: number, docs: number, bytes: number) => ({
  'INDEX.sizeInBytes': bytes, 'QUERY./select.errors': { count: errors, meanRate: 0, '1minRate': 0, '5minRate': 0, '15minRate': 0 },
  'QUERY./select.requestTimes': requests, 'SEARCHER.searcher.numDocs': docs,
});
const HOPPER = { 'solr.core.hopper': core(timer(120, 4.5, 12.25), 3, 42, 81_920) };

describe('the Solr meter', () => {
  it('reads the queries, failed queries, query time, documents and index size from the metrics API', async () => {
    const meter = createSolrMeter({ url: await serve(200, metrics(HOPPER)) });
    expect(await meter.read()).toEqual({ queries: 120, errors: 3, meanMs: 4.5, p95Ms: 12.25, docs: 42, indexBytes: 81_920 });
  });

  it('before any query, there is no query time', async () => {
    const meter = createSolrMeter({ url: await serve(200, metrics({ 'solr.core.hopper': core(timer(0, 0, 0), 0, 42, 81_920) })) });
    expect(await meter.read()).toEqual({ queries: 0, errors: 0, docs: 42, indexBytes: 81_920 });
  });

  it('the metrics URL is the Solr of the core HOPPER_SOLR_URL names', () => {
    const u = new URL(solrMetricsUrl('http://solr:8983/solr/hopper'));
    expect(`${u.origin}${u.pathname}`).toBe('http://solr:8983/solr/admin/metrics');
    expect(Object.fromEntries(u.searchParams)).toEqual({ wt: 'json', group: 'core', prefix: 'QUERY./select.requestTimes,QUERY./select.errors,SEARCHER.searcher.numDocs,INDEX.sizeInBytes' });
    expect(new URL(solrMetricsUrl('http://solr:8983/solr/hopper/')).pathname).toBe('/solr/admin/metrics');
  });

  it('a core Solr does not hold, an error status, or no answer is a failed read', async () => {
    await expect(createSolrMeter({ url: await serve(200, metrics({})) }).read()).rejects.toThrow(/no core hopper/);
    await new Promise((r) => server!.close(r)); server = undefined;
    // Another core, or another collection whose name starts with this one's, is not this one.
    await expect(createSolrMeter({ url: await serve(200, metrics({ 'solr.core.hopper2': HOPPER['solr.core.hopper'], 'solr.core.hopper.x.shard1.replica_n1': HOPPER['solr.core.hopper'] })) }).read()).rejects.toThrow(/no core hopper/);
    await new Promise((r) => server!.close(r)); server = undefined;
    await expect(createSolrMeter({ url: await serve(503, { error: { msg: 'down' } }) }).read()).rejects.toThrow(/answered 503/);
    const port = (server!.address() as AddressInfo).port;
    await new Promise((r) => server!.close(r)); server = undefined;
    await expect(createSolrMeter({ url: `http://127.0.0.1:${port}/solr/hopper` }).read()).rejects.toThrow(/did not answer/);
  });
});

describe('the Solr meter on a SolrCloud collection (issue #2990)', () => {
  it('sums the queries, failed queries and index size of every replica of the collection on the node, and counts each shard\'s documents once', async () => {
    const meter = createSolrMeter({ url: await serve(200, metrics({
      'solr.core.hopper.shard1.replica_n1': core(timer(30, 2, 5), 1, 10, 1_000),
      'solr.core.hopper.shard1.replica_n3': core(timer(10, 6, 9), 0, 10, 1_100),
      'solr.core.hopper.shard2.replica_n2': core(timer(0, 0, 0), 2, 7, 900),
      'solr.core.other.shard1.replica_n1': core(timer(500, 50, 90), 9, 999, 99_999),
    })) });
    expect(await meter.read()).toEqual({ queries: 40, errors: 3, meanMs: 3, p95Ms: 9, docs: 17, indexBytes: 3_000 });
  });
});

describe('the Solr meter against a real Solr', () => {
  let solr: TestSolr;
  beforeAll(async () => { solr = await startTestSolr(); }, 180_000);
  afterAll(async () => { await solr?.stop(); });

  it('after documents are written and searched, reads the queries, their time, the documents and the index size', async () => {
    const index = createSolrIndex({ url: solr.url });
    await index.ensureSchema();
    const scope = { instance: randomUUID(), user: 'u1' };
    const at = '2026-10-01T10:00:00.000Z';
    await index.put(['a', 'b', 'c'].map((ref) => ({ id: `${scope.instance}/u1/job/${ref}`, instance: scope.instance, user: 'u1', type: 'job' as const, ref, private: false, title: `job ${ref}`, status: 'finished', labels: [], created: at, updated: at })));
    await waitFor(async () => (await index.count(scope)) === 3, { timeoutMs: 15_000, what: '3 documents' });
    await index.search(scope, { text: 'job', limit: 10, offset: 0 });
    const r = await createSolrMeter({ url: solr.url }).read();
    expect(r.queries).toBeGreaterThanOrEqual(2);
    expect(r.errors).toBeGreaterThanOrEqual(0);
    expect(r.meanMs).toBeGreaterThan(0);
    expect(r.p95Ms).toBeGreaterThan(0);
    expect(r.docs).toBeGreaterThanOrEqual(3);
    expect(r.indexBytes).toBeGreaterThan(0);
  });
});
