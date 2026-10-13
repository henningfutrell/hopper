// Search in the UI (issue #945, design.md "Search"), pure: a search as the Search view keeps it in the URL hash
// (#search/q=…&status=…, so a link and the back button work), the GET /api/search it reads, a facet value picked or put
// back, and a hit's highlight as text parts. Solr's highlighter answers HTML-encoded text with <mark> around each match;
// it is read here into text, never put into the page as HTML.
import type { SearchFacet } from './wire.ts';

/** A search: the words, the filters, and where its page starts. Each filter holds the values picked; none matches all. */
export interface SearchFilters { q: string; type: string[]; status: string[]; label: string[]; repo: string[]; offset: number }

export const PAGE = 20;

export const emptySearch = (q = ''): SearchFilters => ({ q, type: [], status: [], label: [], repo: [], offset: 0 });

/** Each facet and the filter (and query parameter) its values go to. */
export const FACET_FILTER: Record<SearchFacet, 'type' | 'status' | 'label' | 'repo'> = { type: 'type', status: 'status', labels: 'label', repo: 'repo' };

const FILTERS = ['type', 'status', 'label', 'repo'] as const;

/** The search as query parameters: `q`, each filter's values (repeated), and `offset` when past the first page. */
function params(f: SearchFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q.trim() !== '') p.set('q', f.q.trim());
  for (const k of FILTERS) for (const v of f[k]) p.append(k, v);
  if (f.offset > 0) p.set('offset', String(f.offset));
  return p;
}

/** The hash that opens the Search view on this search. Its `/` and `#` are encoded, so the view's section is one part. */
export const searchHash = (f: SearchFilters): string => `#search/${encodeURIComponent(params(f).toString())}`;

/** The search a Search view section (after `#search/`) holds; anything it lacks is left empty. */
export function parseSearch(section: string): SearchFilters {
  let p: URLSearchParams;
  try { p = new URLSearchParams(decodeURIComponent(section)); } catch { p = new URLSearchParams(); }
  const offset = Number(p.get('offset') ?? 0);
  return {
    q: p.get('q') ?? '',
    type: p.getAll('type'), status: p.getAll('status'), label: p.getAll('label'), repo: p.getAll('repo'),
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
  };
}

/** The read of one page of the search. */
export function searchPath(f: SearchFilters, limit = PAGE): string {
  const p = params(f);
  p.set('limit', String(limit));
  p.set('offset', String(f.offset));
  return `/api/search?${p}`;
}

export const suggestPath = (q: string, limit = 8): string => `/api/search/suggest?${new URLSearchParams({ q, limit: String(limit) })}`;

/** A facet value picked: it filters; picked again: it no longer does. Either way the page starts again. */
export function toggleFilter(f: SearchFilters, facet: SearchFacet, value: string): SearchFilters {
  const k = FACET_FILTER[facet];
  const has = f[k].includes(value);
  return { ...f, [k]: has ? f[k].filter((v) => v !== value) : [...f[k], value], offset: 0 };
}

export const picked = (f: SearchFilters, facet: SearchFacet, value: string): boolean => f[FACET_FILTER[facet]].includes(value);

/** The UI route of a hit: a job's view, an artifact's (part 3), the Infra page for an infra plan (it has no view of its own). */
export function hitHref(h: { type: string; ref: string }): string {
  if (h.type === 'artifact') return `#artifacts/${encodeURIComponent(h.ref)}`;
  if (h.type === 'infra-plan') return '#infra';
  return `#job/${encodeURIComponent(h.ref)}`;
}

/** The words that name a hit's type, beside its title; a job's says nothing more. */
export const TYPE_LABEL: Readonly<Record<string, string>> = { artifact: 'Artifact', 'infra-plan': 'Infra plan' };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** HTML-encoded text as text: the named entities Solr writes, and numeric ones. */
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export interface HighlightPart { text: string; mark: boolean }

/** A highlight as text parts: each match marked. Only `<mark>` and `</mark>` are read as tags; the rest is text. */
export function highlightParts(html: string): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let mark = false;
  for (const piece of html.split(/(<mark>|<\/mark>)/)) {
    if (piece === '<mark>') { mark = true; continue; }
    if (piece === '</mark>') { mark = false; continue; }
    if (piece !== '') parts.push({ text: decode(piece), mark });
  }
  return parts;
}

/** The fields a hit's snippets come from, in the order shown, with the words that name each. */
export const SNIPPET_FIELDS: readonly { field: string; label: string }[] = [
  { field: 'brief', label: 'Asked' }, { field: 'result', label: 'Result' }, { field: 'questions', label: 'Question' },
  { field: 'failure', label: 'Failure' }, { field: 'verdict', label: 'Verdict' }, { field: 'content', label: 'Text' },
];

/** At most `max` snippets of a hit, by field order. */
export function snippets(highlights: Record<string, string[]>, max = 2): { label: string; html: string }[] {
  const out: { label: string; html: string }[] = [];
  for (const { field, label } of SNIPPET_FIELDS) for (const html of highlights[field] ?? []) if (out.length < max) out.push({ label, html });
  return out;
}
