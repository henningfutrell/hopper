// Issue #945: the search index in a real Solr (test/support/solr.ts), one core made from Solr's default config as
// compose.yaml makes it. The hopper puts its schema in; documents are written, found by their words with highlights and
// facets, filtered, suggested from, counted and removed — each hopper and user apart. A Solr that cannot be reached, and
// a field the schema lacks, are errors in their own words.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchDocument, SearchIndex, SearchScope } from '../../src/domain/search.ts';
import { createSolrIndex } from '../../src/search/solr.ts';
import { startTestSolr, type TestSolr } from '../support/solr.ts';
import { waitFor } from '../support/wait.ts';

let solr: TestSolr;
let index: SearchIndex;
beforeAll(async () => {
  solr = await startTestSolr();
  index = createSolrIndex({ url: solr.url });
  await index.ensureSchema();
}, 180_000);
afterAll(async () => { await solr?.stop(); });

const at = '2026-10-01T10:00:00.000Z';
const doc = (scope: SearchScope, ref: string, o: Partial<SearchDocument> = {}): SearchDocument => ({
  id: `${scope.instance}/${scope.user}/job/${ref}`, instance: scope.instance, user: scope.user, type: 'job', ref, private: false,
  title: `job ${ref}`, status: 'finished', labels: [], created: at, updated: at, ...o,
});
const fresh = (): SearchScope => ({ instance: randomUUID(), user: 'u1' });
const written = (scope: SearchScope, n: number) => waitFor(async () => (await index.count(scope)) === n, { timeoutMs: 15_000, what: `${n} documents` });

describe('the search index in Solr (issue #945)', () => {
  it('puts its schema in again without harm, and refuses a field the schema lacks', async () => {
    await index.ensureSchema();
    const scope = fresh();
    await expect(index.put([{ ...doc(scope, 'x'), bogus: 'x' } as SearchDocument])).rejects.toThrow(/Solr answered 400: .*unknown field 'bogus'/);
  });

  it('finds a job by its words, best match first, with the matched parts marked and the rest escaped, and counts the facets', async () => {
    const scope = fresh();
    await index.put([
      doc(scope, 'a', { title: 'Fix the login <b>page</b>', brief: 'The login page fails on Safari', labels: ['bug', 'hopper'], repo: 'o/r', status: 'failed', failure: 'tests failed' }),
      doc(scope, 'b', { title: 'Write the release notes', brief: 'Mention the login fix', labels: ['docs'], repo: 'o/s' }),
      doc(scope, 'c', { title: 'Tidy the CSS', labels: ['hopper'], repo: 'o/r' }),
    ]);
    await written(scope, 3);
    const r = await index.search(scope, { text: 'login', limit: 10, offset: 0 });
    expect(r.total).toBe(2);
    expect(r.hits.map((h) => h.ref)).toEqual(['a', 'b']);
    expect(r.hits[0]).toMatchObject({ type: 'job', title: 'Fix the login <b>page</b>', status: 'failed', labels: ['bug', 'hopper'], repo: 'o/r', private: false });
    expect(r.hits[0]!.highlights.title).toEqual(['Fix the <mark>login</mark> &lt;b&gt;page&lt;&#x2F;b&gt;']);
    expect(r.facets).toEqual({ type: { job: 2 }, status: { failed: 1, finished: 1 }, labels: { bug: 1, hopper: 1, docs: 1 }, repo: { 'o/r': 1, 'o/s': 1 } });
    // Words that are Lucene syntax are words: no error.
    expect((await index.search(scope, { text: 'login (( "page:', limit: 10, offset: 0 })).total).toBeGreaterThanOrEqual(0);
  });

  it('filters by type, status, every label given, repository and the time it was made; empty text matches every job', async () => {
    const scope = fresh();
    await index.put([
      doc(scope, 'a', { labels: ['sme:identity', 'urgent'], status: 'running', repo: 'o/r', created: '2026-10-01T00:00:00.000Z' }),
      doc(scope, 'b', { labels: ['sme:identity'], status: 'queued', repo: 'o/s', created: '2026-10-05T00:00:00.000Z' }),
    ]);
    await written(scope, 2);
    const refs = async (q: Partial<Parameters<SearchIndex['search']>[1]>) => (await index.search(scope, { text: '', limit: 10, offset: 0, ...q })).hits.map((h) => h.ref).sort();
    expect(await refs({})).toEqual(['a', 'b']);
    expect(await refs({ types: ['job'] })).toEqual(['a', 'b']);
    expect(await refs({ statuses: ['running', 'failed'] })).toEqual(['a']);
    expect(await refs({ labels: ['sme:identity', 'urgent'] })).toEqual(['a']);
    expect(await refs({ repos: ['o/s'] })).toEqual(['b']);
    expect(await refs({ from: '2026-10-03T00:00:00.000Z' })).toEqual(['b']);
    expect(await refs({ to: '2026-10-03T00:00:00.000Z' })).toEqual(['a']);
    expect(await refs({ limit: 1, offset: 1 })).toHaveLength(1);
  });

  it('suggests titles whose words start with what was typed', async () => {
    const scope = fresh();
    await index.put([doc(scope, 'a', { title: 'Unlock a sign-in', private: true }), doc(scope, 'b', { title: 'Fix the login page' })]);
    await written(scope, 2);
    expect(await index.suggest(scope, 'unl', 5)).toEqual([{ type: 'job', ref: 'a', private: true, title: 'Unlock a sign-in' }]);
    expect((await index.suggest(scope, 'fix log', 5)).map((s) => s.ref)).toEqual(['b']);
    expect(await index.suggest(scope, '  ', 5)).toEqual([]);
  });

  it('keeps each hopper and each user apart, and removes documents by id', async () => {
    const scope = fresh();
    const other = { ...scope, user: 'u2' }, elsewhere = { ...scope, instance: randomUUID() };
    await index.put([doc(scope, 'a', { title: 'shared word' }), doc(other, 'b', { title: 'shared word' }), doc(elsewhere, 'c', { title: 'shared word' })]);
    await written(scope, 1);
    expect((await index.search(scope, { text: 'shared', limit: 10, offset: 0 })).hits.map((h) => h.ref)).toEqual(['a']);
    expect((await index.suggest(other, 'shar', 5)).map((h) => h.ref)).toEqual(['b']);
    await index.remove([doc(scope, 'a').id, 'no-such-id']);
    await written(scope, 0);
    expect(await index.count(other)).toBe(1);
  });

  it('says Solr was not reached, in its own words', async () => {
    await expect(createSolrIndex({ url: 'http://127.0.0.1:9/solr/hopper' }).count(fresh())).rejects.toThrow(/^Solr not reached: /);
  });
});
