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
const metrics = (core: Record<string, unknown>) => ({ responseHeader: { status: 0, QTime: 0 }, metrics: core });
const HOPPER = {
  'solr.core.hopper:QUERY./select.requestTimes': timer(120, 4.5, 12.25),
  'solr.core.hopper:QUERY./select.errors': { count: 3, meanRate: 0, '1minRate': 0, '5minRate': 0, '15minRate': 0 },
  'solr.core.hopper:SEARCHER.searcher.numDocs': 42,
  'solr.core.hopper:INDEX.sizeInBytes': 81_920,
};

describe('the Solr meter', () => {
  it('reads the queries, failed queries, query time, documents and index size from the metrics API', async () => {
    const meter = createSolrMeter({ url: await serve(200, metrics(HOPPER)) });
    expect(await meter.read()).toEqual({ queries: 120, errors: 3, meanMs: 4.5, p95Ms: 12.25, docs: 42, indexBytes: 81_920 });
  });

  it('before any query, there is no query time', async () => {
    const meter = createSolrMeter({ url: await serve(200, metrics({ ...HOPPER, 'solr.core.hopper:QUERY./select.requestTimes': timer(0, 0, 0), 'solr.core.hopper:QUERY./select.errors': { count: 0 } })) });
    expect(await meter.read()).toEqual({ queries: 0, errors: 0, docs: 42, indexBytes: 81_920 });
  });

  it('the metrics URL is the Solr of the core HOPPER_SOLR_URL names', () => {
    const u = new URL(solrMetricsUrl('http://solr:8983/solr/hopper'));
    expect(`${u.origin}${u.pathname}`).toBe('http://solr:8983/solr/admin/metrics');
    expect(u.searchParams.getAll('key')).toEqual(expect.arrayContaining(['solr.core.hopper:QUERY./select.requestTimes', 'solr.core.hopper:INDEX.sizeInBytes']));
    expect(new URL(solrMetricsUrl('http://solr:8983/solr/hopper/')).pathname).toBe('/solr/admin/metrics');
  });

  it('a core Solr does not hold, an error status, or no answer is a failed read', async () => {
    await expect(createSolrMeter({ url: await serve(200, metrics({})) }).read()).rejects.toThrow(/no core hopper/);
    await expect(createSolrMeter({ url: await serve(503, { error: { msg: 'down' } }) }).read()).rejects.toThrow(/answered 503/);
    const port = (server!.address() as AddressInfo).port;
    await new Promise((r) => server!.close(r)); server = undefined;
    await expect(createSolrMeter({ url: `http://127.0.0.1:${port}/solr/hopper` }).read()).rejects.toThrow(/did not answer/);
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
