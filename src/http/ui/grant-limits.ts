// Grant limits (issue #892, design.md "Grant limits"): what each mutation acts on, so a limited grant's token is held to
// the repositories and job sources its grant names. A route on the table below names its **targets** from its path and
// its body, once the body is read; a route not on it names none, and a limited grant may not use it (deny by default).
// The grant's scopes, role, box flag and Access are checked before this; reads are not limited.
import type { FastifyRequest } from 'fastify';
import { DIRECT_SOURCE } from '../../domain/direct-jobs.ts';
import { limitRefusal, repoOfItemKey, type LimitTarget } from '../../domain/grant-limits.ts';
import { REVIEW_KINDS, REVIEW_SECTIONS } from '../../domain/review.ts';
import type { UserStore } from '../../domain/store.ts';
import type { Job } from '../../domain/types.ts';
import type { ApiGrants } from './api-grants.ts';
import type { UiSession } from './sessions.ts';

type Fields = Record<string, unknown>;
/** The targets of an act: from its path's params and its body, with the user's store to find the job they name. */
type TargetsOf = (params: Fields, body: Fields, store: UserStore) => LimitTarget[];

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** A job's target: its job source and its repository. None when there is no such job: the act has nothing to act on. */
const ofJob = (job: Job | undefined): LimitTarget[] => (job ? [{
  ...(job.source?.repo ? { repo: job.source.repo } : {}), ...(job.source ? { source: job.source.source } : {}),
}] : []);
const jobById = (id: unknown, store: UserStore): LimitTarget[] => {
  const s = text(id);
  return s === undefined ? [] : ofJob(store.jobs.get(s));
};

/** Routes by prefix (as registered): every route under it acts on the job its `:id` names, or the job of the thing it names. */
const PREFIXES: [string, TargetsOf][] = [
  ['/ui/api/jobs/:id/', (p, _b, store) => jobById(p.id, store)],
  ['/ui/api/questions/:id/', (p, _b, store) => {
    const q = text(p.id) === undefined ? undefined : store.questions.get(String(p.id));
    return q ? jobById(q.jobId, store) : [];
  }],
  ...REVIEW_KINDS.map((k): [string, TargetsOf] => [`/ui/api/${REVIEW_SECTIONS[k].section}/:id/`, (p, _b, store) => {
    const item = text(p.id) === undefined ? undefined : store.reviews[k].get(String(p.id));
    return item ? jobById(item.jobId, store) : [];
  }]),
];

/** A bulk decision (issue #1659): the job of each item its body names. */
const bulkReviews = REVIEW_KINDS.flatMap((k) => REVIEW_SECTIONS[k].decisions.filter((d) => d.effect === 'reject').map((d): [string, TargetsOf] => [
  `/ui/api/${REVIEW_SECTIONS[k].section}/${d.route}`,
  (_p, b, store) => (Array.isArray(b.ids) ? b.ids : []).flatMap((id) => {
    const item = text(id) === undefined ? undefined : store.reviews[k].get(String(id));
    return item ? jobById(item.jobId, store) : [];
  }),
]));

/** Routes by their exact path. */
const ROUTES: Record<string, TargetsOf> = {
  ...Object.fromEntries(bulkReviews),
  '/ui/api/failures/:id/retry': (p, _b, store) => jobById(p.id, store),
  '/ui/api/pull-requests/merge': (_p, b, store) => jobById(b.jobId, store),
  '/ui/api/pull-requests/close': (_p, b, store) => jobById(b.jobId, store),
  '/ui/api/pull-requests/tend': (_p, b, store) => jobById(b.jobId, store),
  '/ui/api/pull-requests/diff': (_p, b) => (text(b.repo) ? [{ repo: String(b.repo) }] : []),
  '/ui/api/repo-checks/queue': (_p, b) => (text(b.repo) ? [{ repo: String(b.repo) }] : []),
  // A direct job (issue #901) is of the job source `direct`, on the repository it names, if any.
  '/ui/api/direct-jobs': (_p, b) => [{ source: DIRECT_SOURCE, ...(text(b.repo) ? { repo: String(b.repo) } : {}) }],
  // A start on a tagged item (issue #2342): the item, of the source in the path, and its direct job, of the source
  // `direct`; both on the item's repository.
  '/ui/api/sources/:name/tagged-start': (p, b) => {
    const repo = text(b.key) === undefined ? undefined : repoOfItemKey(String(b.key));
    const source = text(p.name);
    return [{ ...(source ? { source } : {}), ...(repo ? { repo } : {}) }, { source: DIRECT_SOURCE, ...(repo ? { repo } : {}) }];
  },
  // Each item named, of the source in the path; its repository when its key is a GitHub issue or pull request URL.
  '/ui/api/sources/:name/intake': (p, b) => {
    const source = text(p.name);
    const keys = Array.isArray(b.keys) ? b.keys.filter((k): k is string => typeof k === 'string') : [];
    return keys.map((k) => {
      const repo = repoOfItemKey(k);
      return { ...(source ? { source } : {}), ...(repo ? { repo } : {}) };
    });
  },
};

/** How the route names its targets, or undefined: it names none (a limited grant may not use it). */
export function targetsOf(route: string): TargetsOf | undefined {
  return ROUTES[route] ?? PREFIXES.find(([prefix]) => route.startsWith(prefix))?.[1];
}

/**
 * Why a limited grant's token may not do this act (issue #892), or undefined: it may, or its grant names no limits, or it
 * is no grant's token.
 */
export function grantLimitRefusal(grants: Pick<ApiGrants, 'live'>, s: Pick<UiSession, 'grantId'>, req: Pick<FastifyRequest, 'params' | 'body'>, route: string | undefined, store: UserStore | undefined): string | undefined {
  if (s.grantId === undefined) return undefined;
  const limits = grants.live(s.grantId)?.limits;
  if (!limits) return undefined;
  const of = route === undefined ? undefined : targetsOf(route);
  if (!of || !store) return limitRefusal(limits, []);
  const fields = (v: unknown): Fields => (v !== null && typeof v === 'object' ? v as Fields : {});
  return limitRefusal(limits, of(fields(req.params), fields(req.body), store));
}
