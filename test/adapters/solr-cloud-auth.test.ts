// Issue #2990: the search index in a managed Solr — a collection on a SolrCloud cluster with basic auth on, and a user
// permitted on that collection only (test/support/solr.ts). With its credentials the hopper puts its schema into the
// collection, writes, counts, finds and suggests there. With wrong credentials, with none, or on a collection the user may
// not use, each call fails as unauthorized, in words that never hold the password.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SearchUnauthorized, type SearchDocument, type SearchScope } from '../../src/domain/search.ts';
import { createSolrIndex } from '../../src/search/solr.ts';
import { startTestSolrCloud, type TestSolrCloud } from '../support/solr.ts';
import { waitFor } from '../support/wait.ts';

let solr: TestSolrCloud;
beforeAll(async () => { solr = await startTestSolrCloud(); }, 240_000);
afterAll(async () => { await solr?.stop(); });

const basic = (user: string, pass: string) => () => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const at = '2026-10-01T10:00:00.000Z';
const scope = (): SearchScope => ({ instance: randomUUID(), user: 'u1' });
const doc = (s: SearchScope, ref: string, title: string): SearchDocument => ({
  id: `${s.instance}/${s.user}/job/${ref}`, instance: s.instance, user: s.user, type: 'job', ref, private: false,
  title, status: 'finished', labels: [], created: at, updated: at,
});

describe('a managed Solr: a SolrCloud collection with basic auth (issue #2990)', () => {
  it('puts its schema into its collection, and writes, counts, finds and suggests there with its credentials', async () => {
    const index = createSolrIndex({ url: solr.url, authorization: basic(solr.user, solr.password) });
    await index.ensureSchema();
    await index.ensureSchema();
    const s = scope();
    await index.put([doc(s, 'a', 'Rotate the cluster certificate'), doc(s, 'b', 'Write the release notes')]);
    await waitFor(async () => (await index.count(s)) === 2, { timeoutMs: 20_000, what: 'two documents' });
    const r = await index.search(s, { text: 'certificate', limit: 10, offset: 0 });
    expect(r.hits.map((h) => h.ref)).toEqual(['a']);
    expect((await index.suggest(s, 'rot', 5)).map((h) => h.ref)).toEqual(['a']);
    await index.remove([doc(s, 'b', '').id]);
    await waitFor(async () => (await index.count(s)) === 1, { timeoutMs: 20_000, what: 'one document' });
  }, 60_000);

  it('fails as unauthorized with wrong credentials or none, and never says the password', async () => {
    const wrong = createSolrIndex({ url: solr.url, authorization: basic(solr.user, 'not-the-password') });
    const err = await wrong.count(scope()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchUnauthorized);
    expect((err as Error).message).toMatch(/^Solr refused the credentials \(401\)/);
    expect((err as Error).message).not.toContain('not-the-password');
    await expect(wrong.ensureSchema()).rejects.toBeInstanceOf(SearchUnauthorized);
    await expect(createSolrIndex({ url: solr.url }).count(scope())).rejects.toThrow(/^Solr refused the credentials \(401\): .*set HOPPER_SOLR_USERNAME/);
  });

  it('fails as unauthorized on a collection the user is not permitted on', async () => {
    const other = createSolrIndex({ url: solr.otherUrl, authorization: basic(solr.user, solr.password) });
    const err = await other.ensureSchema().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchUnauthorized);
    expect((err as Error).message).toMatch(/^Solr refused the request \(403\): the Solr user may not use this core or collection/);
  });
});
