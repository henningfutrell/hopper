// Search (issue #945, design.md "Search"): the search index's documents, a search and its answer. Postgres is the source of
// truth; the index is a copy that is rebuilt from it at any time. Pure types and the parts that read them.

/**
 * What a search document is of: a job, an artifact (part 3), an infra plan (part 3), an issue the issue graph keeps — an
 * intake item among them — and a pull request linked to one (part 4).
 */
export const SEARCH_TYPES = ['job', 'artifact', 'infra-plan', 'issue', 'pull-request'] as const;
export type SearchType = typeof SEARCH_TYPES[number];

/** Whose documents a search reads: one hopper (its instance id), one user of it. */
export interface SearchScope { instance: string; user: string }

/**
 * One document of the search index: a job, an artifact or an infra plan, and what it holds. Its text is masked
 * (src/secrets/mask.ts) before it is built: a secret, a vault value or a credential is never indexed.
 */
export interface SearchDocument {
  /** `<instance>/<user>/<type>/<ref>`: unique in the core, whatever hopper shares it. */
  id: string;
  instance: string;
  user: string;
  type: SearchType;
  /** Its id: the job's, the artifact's, the plan's; an issue's or a pull request's URL. */
  ref: string;
  /** Only its owner sees it: a direct job (issue #901), and an artifact or a plan of one. */
  private: boolean;
  title: string;
  /** What the job was asked to do (a direct job's brief, else its prompt); an artifact's summary and note; a plan's summary. */
  brief?: string;
  /** A job's status; a plan's (`recorded`, `approved`, `failed`); an issue's or a pull request's state on GitHub (`open`, `closed`, `merged`); an artifact has none. */
  status?: string;
  labels: string[];
  repo?: string;
  /** The job source it came from (`github`, `direct`). */
  source?: string;
  /** Who asked for it: the issue's author, or who submitted the direct job. */
  requester?: string;
  machine?: string;
  lane?: string;
  /** Its result, its pull request when it shipped part, its questions with their answers. */
  result?: string;
  questions?: string[];
  /** Why it failed, and the failure assessor's verdict. */
  failure?: string;
  verdict?: string;
  /** An artifact's text, where it is cheap to read (markdown, text, CSV, JSON; HTML and SVG without their tags). */
  content?: string;
  /** The job an artifact or a plan is of; an issue's job; a pull request's, the job of an issue it closes. */
  job?: string;
  /** The issues, pull requests and Projects linked to an issue or a pull request, in words (`closed by o/r#9`). */
  links?: string[];
  /** What intake did with an issue a source lists now: `taken: job <status>`, or `not taken: <reason>`. */
  intake?: string;
  created: string;
  updated: string;
  finished?: string;
}

/** A search: the text and the filters. Every filter left out matches every document. */
export interface SearchQuery {
  text: string;
  types?: SearchType[];
  statuses?: string[];
  labels?: string[];
  repos?: string[];
  /** Created at or after `from`, before `to` (ISO). */
  from?: string; to?: string;
  limit: number;
  offset: number;
}

/** The facets a search counts. */
export const SEARCH_FACETS = ['type', 'status', 'labels', 'repo'] as const;
export type SearchFacet = typeof SEARCH_FACETS[number];

/** One hit as the index answers it, before Access decided it. */
export interface IndexHit {
  type: SearchType;
  ref: string;
  private: boolean;
  title: string;
  status?: string;
  labels: string[];
  repo?: string;
  /** The job an artifact, a plan, an issue or a pull request is of. */
  job?: string;
  created: string;
  updated: string;
  /** The parts of its fields that matched, `<mark>`…`</mark>` around each match, the rest escaped HTML; by field. */
  highlights: Record<string, string[]>;
}

/** What the index answers for a search: the hits of the page, how many matched, the facet counts. */
export interface IndexAnswer {
  hits: IndexHit[];
  total: number;
  facets: Record<SearchFacet, Record<string, number>>;
}

/** One suggestion for type-ahead: a title that starts with what was typed. */
export interface IndexSuggestion { type: SearchType; ref: string; private: boolean; title: string; job?: string }

/**
 * Whether search can answer now: `ok`; `degraded` (Solr not reached, or Access not asked: `why` says which); or
 * `not-configured` (no HOPPER_SOLR_URL). Search being down stops nothing else.
 */
export type SearchState = 'ok' | 'degraded' | 'not-configured';

/** The index's state for one user: whether it answers, the updates not written yet, and the backfill. */
export interface SearchStatus {
  state: SearchState;
  why?: string;
  /** Pending index updates: documents to write again once Solr takes them. */
  pending: number;
  /** When the last backfill was asked (ISO), and whether it is done: every document it marked is written. */
  backfill?: { at: string; done: boolean };
}

/** A search's answer to a person: the hits Access let them see. */
export interface SearchAnswer {
  state: SearchState;
  why?: string;
  /** How many documents matched, before Access decided each hit of the page. */
  total: number;
  hits: (Omit<IndexHit, 'private'> & { url: string })[];
  facets: Record<SearchFacet, Record<string, number>>;
}

export interface SuggestAnswer {
  state: SearchState;
  why?: string;
  suggestions: (Omit<IndexSuggestion, 'private'> & { url: string })[];
}

export const emptyFacets = (): Record<SearchFacet, Record<string, number>> => ({ type: {}, status: {}, labels: {}, repo: {} });

/** A document's id in the core. */
export const searchDocumentId = (scope: SearchScope, type: SearchType, ref: string): string => `${scope.instance}/${scope.user}/${type}/${ref}`;

/**
 * Where a hit is seen in the UI (after `#`): a job's view, an artifact's, the Infra page for a plan; an issue's or a pull
 * request's job. Undefined: an issue or a pull request with no job, seen at its own URL on GitHub.
 */
export function searchHitRoute(type: SearchType, ref: string, job?: string): string | undefined {
  if (type === 'artifact') return `artifacts/${encodeURIComponent(ref)}`;
  if (type === 'infra-plan') return 'infra';
  if (type === 'issue' || type === 'pull-request') return job === undefined ? undefined : `job/${encodeURIComponent(job)}`;
  return `job/${encodeURIComponent(ref)}`;
}

/** A pending index update's key: what to build again (`job:<id>`, `artifact:<id>`, `infra-plan:<id>`, `issue:<url>`, `pull-request:<url>`). */
export const pendingKey = (type: SearchType, ref: string): string => `${type}:${ref}`;
export function parsePendingKey(key: string): { type: SearchType; ref: string } | undefined {
  const i = key.indexOf(':');
  const type = key.slice(0, i);
  return i > 0 && (SEARCH_TYPES as readonly string[]).includes(type) ? { type: type as SearchType, ref: key.slice(i + 1) } : undefined;
}

/**
 * The search index (issue #945): Solr in the stack, behind this seam (src/search/solr.ts). Every call throws when the index
 * cannot be reached or refuses it, in its own words; the caller says search is degraded and goes on.
 */
export interface SearchIndex {
  /** Put the hopper's fields and field types in the core's schema, and stop it adding fields of its own. Idempotent. */
  ensureSchema(): Promise<void>;
  /** Add or replace these documents; visible to a search within a second. */
  put(docs: readonly SearchDocument[]): Promise<void>;
  /** Remove these documents by id; an id it lacks is no error. */
  remove(ids: readonly string[]): Promise<void>;
  /** How many documents the scope holds. */
  count(scope: SearchScope): Promise<number>;
  search(scope: SearchScope, query: SearchQuery): Promise<IndexAnswer>;
  /** Titles that start with `prefix` (each word typed in full, the last one its start), newest first. */
  suggest(scope: SearchScope, prefix: string, limit: number): Promise<IndexSuggestion[]>;
}

/**
 * Pending index updates (issue #945, tenant migration 50): the documents to build and write again. An event marks the job,
 * artifact or plan it names; a write that Solr took clears the mark, unless it was marked again meanwhile. Solr down: they wait.
 */
export interface SearchPendingRepository {
  /** Mark these keys; one already marked is marked again (its version goes up). */
  mark(keys: readonly string[]): void;
  /** Mark every job, artifact, infra plan, and issue and pull request of the issue graph of the user (the backfill); answers how many. */
  markAll(): number;
  /** The oldest marked keys, with the version each was marked at. */
  take(limit: number): { key: string; version: number }[];
  /** Clear these marks, each only at the version taken: a key marked again since stays. */
  clear(taken: readonly { key: string; version: number }[]): void;
  count(): number;
}
