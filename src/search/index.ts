// Search for one user (issue #945, design.md "Search"): the index kept from job events, the backfill, and the search
// and suggest reads with each hit decided by Access.
//
// - **Index updates.** Each event that names a job marks the job pending (`search_pending`, a table in the user's
//   schema); an `artifact.*` event marks its artifact, an `infra.plan_*` event its plan (part 3). A pass every 2 seconds
//   builds each pending document again from Postgres and writes it to Solr; a mark is cleared only once Solr took the
//   write, so a document changed while Solr is down is written when it is back. One that is gone is removed.
// - **Backfill.** At the first pass that reaches Solr, a user whose documents the core lacks (none for this hopper and
//   user: a new core, a lost volume) has every job, artifact and plan marked; `reindex` marks them again when a person asks.
// - **Degraded.** Solr not reached: the pass waits longer each time (up to a minute), a search answers `degraded` with
//   why, and nothing else waits on it. Access not asked: the hits are hidden, and the search says so.
import type { Access } from '../authz/access-port.ts';
import type { Clock } from '../domain/ports.ts';
import {
  emptyFacets, parsePendingKey, pendingKey, searchDocumentId,
  type SearchAnswer, type SearchDocument, type SearchIndex, type SearchQuery, type SearchScope, type SearchStatus, type SearchType, type SuggestAnswer,
} from '../domain/search.ts';
import type { DomainEvent } from '../domain/types.ts';
import type { UserStore } from '../domain/store.ts';
import { DIRECT_SOURCE } from '../domain/direct-jobs.ts';
import { artifactDocument, CONTENT_READ_MAX, jobDocument, planDocument } from './document.ts';

export const SEARCH_PASS_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** Documents per write, and writes per pass: a backfill of many jobs is written over several passes. */
const BATCH = 100, BATCHES_PER_PASS = 10;
export const NO_SOLR = 'search is not set up: set HOPPER_SOLR_URL (docs/deploy.md "Search")';

/**
 * The pending keys of the documents an event changes: its job; an `artifact.*` event's artifact (and, for a merge, the
 * one it went into); an `infra.plan_*` event's plan.
 */
export function keysOf(e: Pick<DomainEvent, 'type' | 'jobId' | 'data'>): string[] {
  const keys = e.jobId ? [pendingKey('job', e.jobId)] : [];
  const d = (e.data ?? {}) as { artifact?: unknown; into?: unknown; plan?: unknown };
  if (e.type.startsWith('artifact.')) for (const id of [d.artifact, d.into]) if (typeof id === 'string') keys.push(pendingKey('artifact', id));
  if (e.type.startsWith('infra.plan_') && typeof d.plan === 'string') keys.push(pendingKey('infra-plan', d.plan));
  return keys;
}

export interface UserSearch {
  /** A search for `viewerId`: the hits Access lets them see. Never throws: Solr not reached is `degraded`. */
  search(viewerId: string, q: SearchQuery): Promise<SearchAnswer>;
  /** Titles that start with what was typed, for type-ahead; the same checks. */
  suggest(viewerId: string, prefix: string, limit: number): Promise<SuggestAnswer>;
  status(): SearchStatus;
  /** Mark every job, artifact and plan of the user pending again (the backfill a person asks for); answers how many. */
  reindex(): number;
  /** One pass now: the pending documents written while Solr takes them (tests, and `reindex`). */
  pass(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

/** What the instance gives each user's search: the index (absent: none), this hopper's instance id, and Access. */
export interface SearchWiring { index: SearchIndex | undefined; instanceId: string; access: Pick<Access, 'decideSearchHit'> }

export function createUserSearch(o: {
  scope: SearchScope;
  store: Pick<UserStore, 'jobs' | 'questions' | 'directJobs' | 'artifacts' | 'infraPlans' | 'events' | 'searchPending'>;
  /** Absent: no HOPPER_SOLR_URL; search answers `not-configured` and nothing is marked. */
  index: SearchIndex | undefined;
  access: Pick<Access, 'decideSearchHit'> | undefined;
  url: (type: SearchType, ref: string) => string;
  clock: Clock;
  logger: { warn(line: string): void };
  passMs?: number;
}): UserSearch {
  const { scope, store, index } = o;
  const passMs = o.passMs ?? SEARCH_PASS_MS;
  // The documents an event named since the last pass (pending keys): kept here until the pass marks them, so an append
  // never writes again inside itself.
  const named = new Set<string>();
  let state: Pick<SearchStatus, 'state' | 'why'> = index ? { state: 'ok' } : { state: 'not-configured', why: NO_SOLR };
  let schemaReady = false, backfillChecked = false, failures = 0, nextAt = 0;
  let backfill: SearchStatus['backfill'];
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let stopped = false;

  const degrade = (why: string): void => {
    if (state.state !== 'degraded' || state.why !== why) o.logger.warn(`hopper: search: degraded, Solr is not written: ${why}`);
    state = { state: 'degraded', why };
    failures++;
    nextAt = o.clock.now().getTime() + Math.min(MAX_BACKOFF_MS, passMs * 2 ** Math.min(failures, 10));
  };

  const documentOf = (type: SearchType, ref: string): SearchDocument | undefined => {
    if (type === 'artifact') {
      const artifact = store.artifacts.get(ref);
      if (!artifact) return undefined;
      const job = store.jobs.get(artifact.jobId);
      return artifactDocument({ scope, artifact, ...(artifact.size <= CONTENT_READ_MAX ? { content: store.artifacts.content(ref) } : {}), ...(job ? { job } : {}) });
    }
    if (type === 'infra-plan') {
      const plan = store.infraPlans.get(ref);
      if (!plan) return undefined;
      const approval = store.infraPlans.approval(ref), job = store.jobs.get(plan.job);
      return planDocument({ scope, plan, ...(approval ? { approval } : {}), ...(job ? { job } : {}) });
    }
    const job = store.jobs.get(ref);
    if (!job) return undefined;
    const key = job.source?.kind === DIRECT_SOURCE ? job.source.key.slice(DIRECT_SOURCE.length + 1) : undefined;
    const direct = key !== undefined ? store.directJobs.get(key) : undefined;
    return jobDocument({ scope, job, questions: store.questions.list({ jobId: job.id }), ...(direct ? { direct } : {}) });
  };

  const write = async (ix: SearchIndex): Promise<void> => {
    if (named.size > 0) {
      const keys = [...named];
      named.clear();
      store.searchPending.mark(keys);
    }
    if (o.clock.now().getTime() < nextAt) return;
    try {
      if (!schemaReady) { await ix.ensureSchema(); schemaReady = true; }
      if (!backfillChecked) {
        if (await ix.count(scope) === 0 && store.searchPending.markAll() > 0) backfill = { at: o.clock.now().toISOString(), done: false };
        backfillChecked = true;
      }
      for (let i = 0; i < BATCHES_PER_PASS; i++) {
        const taken = store.searchPending.take(BATCH);
        if (taken.length === 0) break;
        const docs: SearchDocument[] = [], gone: string[] = [];
        for (const t of taken) {
          const k = parsePendingKey(t.key);
          if (!k) continue;
          const d = documentOf(k.type, k.ref);
          if (d) docs.push(d); else gone.push(searchDocumentId(scope, k.type, k.ref));
        }
        await ix.put(docs);
        await ix.remove(gone);
        store.searchPending.clear(taken);
      }
      if (backfill && !backfill.done && store.searchPending.count() === 0) backfill = { ...backfill, done: true };
      if (state.state === 'degraded') o.logger.warn('hopper: search: Solr is written again');
      state = { state: 'ok' }; failures = 0; nextAt = 0;
    } catch (e) {
      degrade((e as Error).message);
    }
  };

  const pass = (): Promise<void> => {
    if (!index || stopped) return Promise.resolve();
    running ??= write(index).finally(() => { running = undefined; });
    return running;
  };

  /** The hits Access lets `viewerId` see, in order; `why` when Access could not be asked. */
  const allowed = async <H extends { type: SearchType; ref: string; private: boolean }>(viewerId: string, hits: H[]): Promise<{ kept: H[]; why?: string }> => {
    if (!o.access) return { kept: [], why: 'access checks are unavailable: Access is not set up' };
    const access = o.access;
    const answers = await Promise.all(hits.map((h) => access.decideSearchHit(viewerId, { ownerId: scope.user, type: h.type, ref: h.ref, private: h.private })));
    const unavailable = answers.find((a) => a.unavailable);
    return { kept: hits.filter((_, i) => answers[i]!.allowed), ...(unavailable ? { why: unavailable.reason } : {}) };
  };

  const stateNow = (): Pick<SearchStatus, 'state' | 'why'> => state;

  return {
    async search(viewerId, q) {
      if (!index) return { state: 'not-configured', why: NO_SOLR, total: 0, hits: [], facets: emptyFacets() };
      let found;
      try { found = await index.search(scope, q); } catch (e) {
        return { state: 'degraded', why: (e as Error).message, total: 0, hits: [], facets: emptyFacets() };
      }
      const { kept, why } = await allowed(viewerId, found.hits);
      const now = why !== undefined ? { state: 'degraded' as const, why } : stateNow();
      return {
        ...now, total: found.total, facets: found.facets,
        hits: kept.map(({ private: _p, ...h }) => ({ ...h, url: o.url(h.type, h.ref) })),
      };
    },
    async suggest(viewerId, prefix, limit) {
      if (!index) return { state: 'not-configured', why: NO_SOLR, suggestions: [] };
      let found;
      try { found = await index.suggest(scope, prefix, limit); } catch (e) {
        return { state: 'degraded', why: (e as Error).message, suggestions: [] };
      }
      const { kept, why } = await allowed(viewerId, found);
      return { ...(why !== undefined ? { state: 'degraded' as const, why } : stateNow()), suggestions: kept.map(({ private: _p, ...s }) => ({ ...s, url: o.url(s.type, s.ref) })) };
    },
    status: () => ({ ...state, pending: index ? store.searchPending.count() + named.size : 0, ...(backfill ? { backfill } : {}) }),
    reindex() {
      if (!index) return 0;
      const n = store.searchPending.markAll();
      backfill = { at: o.clock.now().toISOString(), done: n === 0 };
      nextAt = 0;
      return n;
    },
    pass,
    start() {
      if (!index || timer || stopped) return;
      unsubscribe = store.events.subscribe((e) => { for (const k of keysOf(e)) named.add(k); });
      timer = setInterval(() => { void pass(); }, passMs);
      timer.unref();
      void pass();
    },
    async stop() {
      stopped = true;
      unsubscribe?.();
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
      // Documents named since the last pass stay marked: the next start writes them.
      if (named.size > 0) store.searchPending.mark([...named]);
      named.clear();
    },
  };
}
