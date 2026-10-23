// @vitest-environment happy-dom
// Search in the UI (issue #945, part 2): the Search view — the hits with
// their matched words marked, the facets that filter, the state when search is degraded or not set up — against a fake of
// the daemon's HTTP. The model is pure: a hit's highlight as text parts (never raw HTML), and a search kept in the URL hash.
//
// Feature: Search in the UI
//   Scenario: a highlight is text with the matched words marked; markup in a job's words stays text
//   Scenario: a search is kept in the hash (#search/q=…&status=…), read back the same, and read as GET /api/search
//   Scenario: the Search view reads the hash's search, shows each hit with a link to its job, and marks the matched words
//   Scenario: a facet value filters the search; picked again, it no longer filters
//   Scenario: search degraded or not set up says why, and shows no hits
//   Scenario: an artifact's hit links to the artifact, an infra plan's to Infra, and an artifact's text is a snippet (part 3)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { highlightParts, hitHref, parseSearch, searchHash, searchPath, snippets, toggleFilter, TYPE_LABEL, type SearchFilters } from '../../ui/src/model/search.ts';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let calls: string[] = [];

const ANSWER = {
  state: 'ok', total: 2,
  facets: { type: { job: 2 }, status: { finished: 1, failed: 1 }, labels: { infra: 2 }, repo: { 'acme/app': 2 } },
  hits: [
    { type: 'job', ref: 'j1', title: 'Clear the build cache', status: 'finished', labels: ['infra'], repo: 'acme/app', created: '2026-10-10T12:00:00.000Z', updated: '2026-10-10T12:05:00.000Z', url: 'http://127.0.0.1:4790/#job/j1',
      highlights: { title: ['Clear the build <mark>cache</mark>'], result: ['the <mark>cache</mark> was cleared &lt;b&gt;now&lt;&#x2F;b&gt;'] } },
    { type: 'job', ref: 'j2', title: 'Warm the cache', status: 'failed', labels: ['infra'], repo: 'acme/app', created: '2026-10-09T12:00:00.000Z', updated: '2026-10-09T12:05:00.000Z', url: 'http://127.0.0.1:4790/#job/j2',
      highlights: { failure: ['the <mark>cache</mark> host was down'] } },
  ],
};

function fakeDaemon(answer: (path: string) => unknown) {
  calls = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => { calls.push(String(path)); return json(answer(String(path))); }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
}

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function renderView(hash: string, answer: (path: string) => unknown = () => ANSWER) {
  window.location.hash = hash;
  fakeDaemon(answer);
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role: 'operator', realm: 'local', identity: 'ada' } });
  const view = '../../ui/src/views/search.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { Search } = (await import(view)) as { Search: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(Search)); });
  await settle();
}

const hits = () => [...document.querySelectorAll('[data-slot="search-hit"]')];

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('the search model', () => {
  it('reads a highlight as text parts, the matched words marked; markup in the words stays text', () => {
    expect(highlightParts('the <mark>cache</mark> was cleared &lt;b&gt;now&lt;&#x2F;b&gt; &amp; &quot;done&quot; &#39;ok&#39;')).toEqual([
      { text: 'the ', mark: false }, { text: 'cache', mark: true }, { text: ' was cleared <b>now</b> & "done" \'ok\'', mark: false },
    ]);
    expect(highlightParts('plain')).toEqual([{ text: 'plain', mark: false }]);
    expect(highlightParts('<mark>a</mark><mark>b</mark>')).toEqual([{ text: 'a', mark: true }, { text: 'b', mark: true }]);
  });

  it('keeps a search in the hash and reads it back the same; the API path carries every filter', () => {
    const f: SearchFilters = { q: 'build cache', type: ['job'], status: ['finished', 'failed'], label: ['sme:infra, ops'], repo: ['acme/app'], offset: 20 };
    const hash = searchHash(f);
    expect(hash.startsWith('#search/')).toBe(true);
    expect(hash.slice(1).split('/')).toHaveLength(2);
    expect(parseSearch(hash.slice('#search/'.length))).toEqual(f);
    expect(parseSearch('')).toEqual({ q: '', type: [], status: [], label: [], repo: [], offset: 0 });
    const p = new URL(searchPath(f, 20), 'http://x');
    expect(p.pathname).toBe('/api/search');
    expect(p.searchParams.get('q')).toBe('build cache');
    expect(p.searchParams.getAll('status')).toEqual(['finished', 'failed']);
    expect(p.searchParams.getAll('label')).toEqual(['sme:infra, ops']);
    expect(p.searchParams.getAll('repo')).toEqual(['acme/app']);
    expect(p.searchParams.get('limit')).toBe('20');
    expect(p.searchParams.get('offset')).toBe('20');
  });

  it('toggles a facet value: picked, it filters and the page starts again; picked again, it does not', () => {
    const f: SearchFilters = { q: 'cache', type: [], status: [], label: [], repo: [], offset: 40 };
    const on = toggleFilter(f, 'status', 'failed');
    expect(on).toEqual({ ...f, status: ['failed'], offset: 0 });
    expect(toggleFilter(on, 'status', 'failed')).toEqual({ ...f, offset: 0 });
    expect(toggleFilter(f, 'labels', 'infra').label).toEqual(['infra']);
  });
});

describe('the Search view', () => {
  it('searches what the hash holds and shows each hit with a link to its job, the matched words marked', async () => {
    await renderView(searchHash({ q: 'cache', type: [], status: [], label: [], repo: [], offset: 0 }));
    expect(calls.some((c) => c.startsWith('/api/search?') && new URL(c, 'http://x').searchParams.get('q') === 'cache')).toBe(true);
    expect(hits()).toHaveLength(2);
    const first = hits()[0]!;
    expect(first.querySelector('a')?.getAttribute('href')).toBe('#job/j1');
    expect([...first.querySelectorAll('mark')].map((m) => m.textContent)).toContain('cache');
    // A job's own markup is text, never HTML.
    expect(first.textContent).toContain('<b>now</b>');
    expect(first.querySelector('b')).toBeNull();
    expect(hits()[1]!.textContent).toContain('failed');
    expect(document.querySelector('[data-slot="search-total"]')?.textContent).toContain('2');
  });

  it('keeps the header with the search form in view, and pages a long answer 20 to a page (issue #2353)', async () => {
    const many = { ...ANSWER, total: 45, hits: Array.from({ length: 20 }, (_, i) => ({ ...ANSWER.hits[1]!, ref: `j${i}` })) };
    await renderView(searchHash({ q: 'cache', type: [], status: [], label: [], repo: [], offset: 0 }), () => many);
    const header = document.querySelector('[data-slot="panel-header"][data-sticky]')!;
    expect(header.className).toContain('sticky');
    expect(header.querySelector('form[role="search"]')).not.toBeNull();
    expect(hits()).toHaveLength(20);
    expect(document.querySelector('[data-slot="search-total"]')?.textContent).toContain('1–20');
    const more = [...document.querySelectorAll('button')].find((b) => b.textContent === 'More')!;
    await act(async () => { more.click(); });
    expect(parseSearch(window.location.hash.replace(/^#search\/?/, '')).offset).toBe(20);
  });

  it('filters by a facet value: the search is read again with it', async () => {
    await renderView(searchHash({ q: 'cache', type: [], status: [], label: [], repo: [], offset: 0 }));
    const facet = [...document.querySelectorAll('[data-slot="search-facet"]')].find((b) => b.getAttribute('data-value') === 'failed') as HTMLButtonElement;
    expect(facet.textContent).toContain('1');
    await act(async () => { facet.click(); });
    await settle();
    expect(window.location.hash).toBe(searchHash({ q: 'cache', type: [], status: ['failed'], label: [], repo: [], offset: 0 }));
    expect(new URL(calls.at(-1)!, 'http://x').searchParams.getAll('status')).toEqual(['failed']);
  });

  it('says why when search is degraded, and when it is not set up', async () => {
    await renderView(searchHash({ q: 'cache', type: [], status: [], label: [], repo: [], offset: 0 }), () => ({ state: 'degraded', why: 'Solr not reached: ECONNREFUSED', total: 0, hits: [], facets: { type: {}, status: {}, labels: {}, repo: {} } }));
    expect(document.querySelector('[data-slot="search-state"]')?.textContent).toContain('Solr not reached: ECONNREFUSED');
    expect(hits()).toHaveLength(0);
    await act(async () => root?.unmount());
    await renderView(searchHash({ q: 'cache', type: [], status: [], label: [], repo: [], offset: 0 }), () => ({ state: 'not-configured', why: 'search is not set up', total: 0, hits: [], facets: { type: {}, status: {}, labels: {}, repo: {} } }));
    expect(document.querySelector('[data-slot="search-state"]')?.textContent).toContain('search is not set up');
  });
});

describe('hits of other documents (issue #945, part 3)', () => {
  it('links an artifact\'s hit to the artifact, an infra plan\'s to Infra, a job\'s to the job', () => {
    expect(hitHref({ type: 'job', ref: 'j/1' })).toBe('#job/j%2F1');
    expect(hitHref({ type: 'artifact', ref: 'a1' })).toBe('#artifacts/a1');
    expect(hitHref({ type: 'infra-plan', ref: 'p1' })).toBe('#infra');
  });

  it('shows an artifact\'s matched text as a snippet', () => {
    expect(snippets({ content: ['the <mark>resolver</mark> timed out'] })).toEqual([{ label: 'Text', html: 'the <mark>resolver</mark> timed out' }]);
  });
});

describe('hits of issues and pull requests (issue #945, part 4)', () => {
  it('links an issue or a pull request to its job, else to the item on GitHub, and never to anything but an https URL', () => {
    expect(hitHref({ type: 'issue', ref: 'https://github.com/o/r/issues/7', job: 'j7' })).toBe('#job/j7');
    expect(hitHref({ type: 'pull-request', ref: 'https://github.com/o/r/pull/9' })).toBe('https://github.com/o/r/pull/9');
    expect(hitHref({ type: 'issue', ref: 'javascript:alert(1)' })).toBe('#search/');
    expect(TYPE_LABEL).toMatchObject({ issue: 'Issue', 'pull-request': 'Pull request' });
  });

  it('shows what is linked to it and what intake did with it as snippets', () => {
    expect(snippets({ links: ['closes o/r#7: Retry the <mark>flaky</mark> upload'], intake: ['not taken: not <mark>assigned</mark> to you'] })).toEqual([
      { label: 'Linked', html: 'closes o/r#7: Retry the <mark>flaky</mark> upload' },
      { label: 'Intake', html: 'not taken: not <mark>assigned</mark> to you' },
    ]);
  });
});
