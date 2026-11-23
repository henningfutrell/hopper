// Issue #2990: the search index in a managed Solr: a collection on a SolrCloud cluster with basic auth on, the app's
// user permitted only on its own collection (test/support/solr.ts `startTestSolrCloud`). The hopper puts its schema in,
// indexes, searches and counts with its credentials on every call, and only on its collection; wrong credentials, or
// none, are `unauthorized`, and the error never carries the credentials.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchDocument, SearchScope } from '../../src/domain/search.ts';
import { createSolrIndex } from '../../src/search/solr.ts';
import { startTestSolrCloud, type TestSolrCloud } from '../support/solr.ts';
import { waitFor } from '../support/wait.ts';

let solr: TestSolrCloud;
beforeAll(async () => { solr = await startTestSolrCloud(); }, 240_000);
afterAll(async () => { await solr?.stop(); });

const at = '2026-10-01T10:00:00.000Z';
const fresh = (): SearchScope => ({ instance: randomUUID(), user: 'u1' });
const doc = (scope: SearchScope, ref: string, title: string): SearchDocument => ({
  id: `${scope.instance}/${scope.user}/job/${ref}`, instance: scope.instance, user: scope.user, type: 'job', ref, private: false,
  title, status: 'finished', labels: [], created: at, updated: at,
});

describe('the search index in a managed SolrCloud collection with basic auth (issue #2990)', () => {
  it('puts its schema in, indexes, searches and counts its own collection with its credentials', async () => {
    const index = createSolrIndex({ url: solr.url, auth: { username: solr.username, password: solr.password } });
    await index.ensureSchema();
    await index.ensureSchema();
    const scope = fresh();
    await index.put([doc(scope, 'a', 'Fix the login page'), doc(scope, 'b', 'Write the release notes')]);
    await waitFor(async () => (await index.count(scope)) === 2, { timeoutMs: 30_000, what: '2 documents' });
    expect((await index.search(scope, { text: 'login', limit: 10, offset: 0 })).hits.map((h) => h.ref)).toEqual(['a']);
    expect((await index.suggest(scope, 'rel', 5)).map((s) => s.ref)).toEqual(['b']);
    await index.remove([doc(scope, 'a', '').id]);
    await waitFor(async () => (await index.count(scope)) === 1, { timeoutMs: 30_000, what: '1 document' });
  });

  it('is unauthorized with wrong credentials or none, and says so without the credentials', async () => {
    const wrong = createSolrIndex({ url: solr.url, auth: { username: solr.username, password: 'not-the-password' } });
    const err = await wrong.count(fresh()).then(() => undefined, (e: Error) => e);
    expect(err?.message).toMatch(/^unauthorized: Solr answered 401/);
    expect(err?.message).not.toContain('not-the-password');
    await expect(createSolrIndex({ url: solr.url }).ensureSchema()).rejects.toThrow(/^unauthorized: Solr answered 401/);
  });

  it('is unauthorized on a collection its user is not permitted on', async () => {
    const other = createSolrIndex({ url: solr.url.replace(/\/hopper$/, '/other'), auth: { username: solr.username, password: solr.password } });
    await expect(other.count(fresh())).rejects.toThrow(/^unauthorized: Solr answered 403/);
  });
});
