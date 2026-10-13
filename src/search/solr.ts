// The search index in Solr (issue #945, design.md "Search"): one core in standalone mode, HOPPER_SOLR_URL
// (http://solr:8983/solr/hopper in compose). Spoken to over Solr's own JSON API with fetch: no Node client for Solr has
// a steady release history, and the five calls this needs (update, select, schema, config, count) are plain HTTP.
// The core is made by the Solr container from Solr's default config (`solr-precreate`); the schema below is the
// hopper's, put in at each start (`ensureSchema`), so a new build adds what it needs to the core it finds.
import type { IndexAnswer, IndexHit, IndexSuggestion, SearchFacet, SearchIndex, SearchQuery, SearchScope, SearchType } from '../domain/search.ts';
import { emptyFacets, SEARCH_FACETS } from '../domain/search.ts';

/** A field of the hopper's schema, as Solr's Schema API takes it. */
interface FieldDef { name: string; type: string; stored?: boolean; indexed?: boolean; multiValued?: boolean; docValues?: boolean }

/** Words typed so far, each matched from its start: a title's words cut into their first 1–20 characters, lowercased. */
const PREFIX_TYPE = {
  name: 'hopper_prefix', class: 'solr.TextField', positionIncrementGap: '100',
  indexAnalyzer: { tokenizer: { class: 'solr.StandardTokenizerFactory' }, filters: [{ class: 'solr.LowerCaseFilterFactory' }, { class: 'solr.EdgeNGramFilterFactory', minGramSize: '1', maxGramSize: '20' }] },
  queryAnalyzer: { tokenizer: { class: 'solr.StandardTokenizerFactory' }, filters: [{ class: 'solr.LowerCaseFilterFactory' }] },
};

const text = (name: string, multiValued = false): FieldDef => ({ name, type: 'text_general', stored: true, indexed: true, multiValued });
const exact = (name: string, multiValued = false): FieldDef => ({ name, type: 'string', stored: true, indexed: true, docValues: true, multiValued });
const date = (name: string): FieldDef => ({ name, type: 'pdate', stored: true, indexed: true, docValues: true });

/** The hopper's fields. `id` is the default config's unique key. */
export const SEARCH_FIELDS: readonly FieldDef[] = [
  exact('instance'), exact('user'), exact('type'), exact('ref'), { name: 'private', type: 'boolean', stored: true, indexed: true, docValues: true },
  text('title'), { name: 'title_prefix', type: PREFIX_TYPE.name, stored: false, indexed: true },
  text('brief'), exact('status'), exact('labels', true), exact('repo'), exact('source'), exact('requester'), exact('machine'), exact('lane'),
  text('result'), text('questions', true), text('failure'), text('verdict'),
  date('created'), date('updated'), date('finished'),
];

/** The text a search matches, each field's weight; and the fields a hit shows matched parts of. */
const QUERY_FIELDS = 'title^6 brief^2 result questions failure verdict labels^3 repo^2 requester status';
const HIGHLIGHTED = ['title', 'brief', 'result', 'questions', 'failure', 'verdict'];
const HIT_FIELDS = 'type,ref,private,title,status,labels,repo,created,updated,id';

/** Lucene's own characters, escaped: a word typed is a word, never syntax. */
const escapeTerm = (s: string): string => s.replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, '\\$&');
/** Any of these values: a type, a status or a repository holds no comma (the route refuses one that does). */
const terms = (field: string, values: readonly string[]): string => `{!terms f=${field}}${values.join(',')}`;
const term = (field: string, value: string): string => `{!term f=${field}}${value}`;

type Json = Record<string, unknown>;
const TIMEOUT_MS = { read: 5_000, write: 15_000 };

export function createSolrIndex(o: { url: string; fetch?: typeof fetch }): SearchIndex {
  const base = o.url.replace(/\/+$/, '');
  const doFetch = o.fetch ?? fetch;

  /** One call to the core; Solr's own error message when it refuses, `Solr not reached: …` when it cannot be reached. */
  const call = async (path: string, init: { method?: 'GET' | 'POST'; params?: URLSearchParams; body?: unknown; timeout: number }): Promise<Json> => {
    const url = `${base}${path}${init.params ? `?${init.params}` : ''}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET', signal: AbortSignal.timeout(init.timeout),
        ...(init.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`Solr not reached: ${cause?.code ?? cause?.message ?? (e as Error).message}`, { cause: e });
    }
    const raw = await res.text();
    let body: Json;
    try { body = JSON.parse(raw) as Json; } catch { throw new Error(`Solr answered ${res.status}, not JSON: ${raw.slice(0, 200)}`); }
    if (!res.ok) {
      const msg = (body.error as { msg?: string } | undefined)?.msg;
      throw new Error(`Solr answered ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return body;
  };

  const scoped = (p: URLSearchParams, scope: SearchScope): URLSearchParams => {
    p.append('fq', term('instance', scope.instance));
    p.append('fq', term('user', scope.user));
    return p;
  };

  const hitOf = (d: Json, highlights: Record<string, string[]>): IndexHit => ({
    type: d.type as SearchType, ref: d.ref as string, private: d.private === true, title: (d.title as string | undefined) ?? '',
    status: d.status as string, labels: (d.labels as string[] | undefined) ?? [],
    ...(typeof d.repo === 'string' ? { repo: d.repo } : {}),
    created: d.created as string, updated: d.updated as string, highlights,
  });

  return {
    async ensureSchema() {
      const types = (await call('/schema/fieldtypes', { timeout: TIMEOUT_MS.write })).fieldTypes as { name: string }[];
      const fields = (await call('/schema/fields', { timeout: TIMEOUT_MS.write })).fields as Json[];
      const copies = (await call('/schema/copyfields', { params: new URLSearchParams({ 'source.fl': 'title' }), timeout: TIMEOUT_MS.write })).copyFields as { source: string; dest: string }[];
      const have = new Map(fields.map((f) => [f.name as string, f]));
      const differs = (f: FieldDef, cur: Json): boolean =>
        cur.type !== f.type || (cur.multiValued === true) !== (f.multiValued === true) || (cur.stored !== false) !== (f.stored !== false);
      const commands: Json = {};
      const add = (verb: string, what: unknown): void => { commands[verb] = [...((commands[verb] as unknown[] | undefined) ?? []), what]; };
      if (types.some((t) => t.name === PREFIX_TYPE.name)) add('replace-field-type', PREFIX_TYPE); else add('add-field-type', PREFIX_TYPE);
      for (const f of SEARCH_FIELDS) {
        const cur = have.get(f.name);
        if (!cur) add('add-field', f); else if (differs(f, cur)) add('replace-field', f);
      }
      if (!copies.some((c) => c.dest === 'title_prefix')) add('add-copy-field', { source: 'title', dest: 'title_prefix' });
      await call('/schema', { method: 'POST', body: commands, timeout: TIMEOUT_MS.write });
      // Fields come only from the schema above: a document with another field is refused, never guessed at.
      await call('/config', { method: 'POST', body: { 'set-user-property': { 'update.autoCreateFields': 'false' } }, timeout: TIMEOUT_MS.write });
    },

    async put(docs) {
      if (docs.length === 0) return;
      await call('/update', { method: 'POST', params: new URLSearchParams({ commitWithin: '1000', wt: 'json' }), body: docs, timeout: TIMEOUT_MS.write });
    },

    async remove(ids) {
      if (ids.length === 0) return;
      await call('/update', { method: 'POST', params: new URLSearchParams({ commitWithin: '1000', wt: 'json' }), body: { delete: [...ids] }, timeout: TIMEOUT_MS.write });
    },

    async count(scope) {
      const r = await call('/select', { params: scoped(new URLSearchParams({ q: '*:*', rows: '0', wt: 'json' }), scope), timeout: TIMEOUT_MS.read });
      return Number((r.response as { numFound?: number } | undefined)?.numFound ?? 0);
    },

    async search(scope, q: SearchQuery): Promise<IndexAnswer> {
      const p = scoped(new URLSearchParams({
        q: q.text.trim() === '' ? '*:*' : q.text, defType: 'edismax', qf: QUERY_FIELDS, 'q.op': 'AND',
        fl: HIT_FIELDS, rows: String(q.limit), start: String(q.offset), sort: 'score desc,updated desc', wt: 'json', 'json.nl': 'map',
        hl: 'true', 'hl.method': 'unified', 'hl.fl': HIGHLIGHTED.join(','), 'hl.encoder': 'html', 'hl.tag.pre': '<mark>', 'hl.tag.post': '</mark>', 'hl.snippets': '2', 'hl.fragsize': '160',
        facet: 'true', 'facet.mincount': '1', 'facet.limit': '50',
      }), scope);
      for (const f of SEARCH_FACETS) p.append('facet.field', f);
      if (q.types?.length) p.append('fq', terms('type', q.types));
      if (q.statuses?.length) p.append('fq', terms('status', q.statuses));
      if (q.labels?.length) for (const l of q.labels) p.append('fq', term('labels', l));
      if (q.repos?.length) p.append('fq', terms('repo', q.repos));
      if (q.from || q.to) p.append('fq', `created:[${q.from ?? '*'} TO ${q.to ?? '*'}}`);
      const r = await call('/select', { params: p, timeout: TIMEOUT_MS.read });
      const docs = ((r.response as { docs?: Json[] } | undefined)?.docs) ?? [];
      const hl = (r.highlighting as Record<string, Record<string, string[]>> | undefined) ?? {};
      const fields = ((r.facet_counts as { facet_fields?: Record<string, Record<string, number>> } | undefined)?.facet_fields) ?? {};
      const facets = emptyFacets();
      for (const f of SEARCH_FACETS) facets[f as SearchFacet] = fields[f] ?? {};
      return {
        total: Number((r.response as { numFound?: number } | undefined)?.numFound ?? 0),
        hits: docs.map((d) => hitOf(d, Object.fromEntries(Object.entries(hl[d.id as string] ?? {}).filter(([, v]) => v.length > 0)))),
        facets,
      };
    },

    async suggest(scope, prefix, limit): Promise<IndexSuggestion[]> {
      const words = prefix.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 10);
      if (words.length === 0) return [];
      const p = scoped(new URLSearchParams({
        q: words.map((w) => `title_prefix:${escapeTerm(w.slice(0, 20))}`).join(' AND '),
        fl: 'type,ref,private,title', rows: String(limit), sort: 'score desc,updated desc', wt: 'json',
      }), scope);
      const r = await call('/select', { params: p, timeout: TIMEOUT_MS.read });
      return (((r.response as { docs?: Json[] } | undefined)?.docs) ?? []).map((d) => ({
        type: d.type as SearchType, ref: d.ref as string, private: d.private === true, title: (d.title as string | undefined) ?? '',
      }));
    },
  };
}
